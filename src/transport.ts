import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The launch contract: the runtime command and nothing else. pi-cua owns no
 * desktop-wide state here — no lock, no sidecar, no lease — so two transports
 * can run at once and one close can never reach the other.
 */
export interface OwnedTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** The one stdio MCP transport. The runtime's own framing is the SDK's. */
const GUARDIAN_PATH = fileURLToPath(new URL('./guardian.mjs', import.meta.url));

/** How long the group gets after SIGTERM before SIGKILL, and the final wait. */
const GRACE_MS = 400;
const WAIT_MS = 2_500;
const POLL_MS = 20;

/** How the launcher ended, for diagnostics. `null` while it is still running. */
export interface ExitFacts {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The connection is over: a close, or a helper that is no longer there. */
export class TransportClosedError extends Error {
  readonly code = 'transport_closed';
  readonly exit: ExitFacts | undefined;

  constructor(message: string, exit?: ExitFacts) {
    super(message);
    this.name = 'TransportClosedError';
    this.exit = exit;
  }
}

/**
 * The process group survived SIGKILL. This is not a clean shutdown: something we
 * started may still be running, and the caller must be told rather than fooled.
 */
export class TransportCleanupError extends Error {
  readonly code = 'transport_cleanup_failed';
  readonly group: number;
  readonly exit: ExitFacts | undefined;

  constructor(group: number, exit: ExitFacts | undefined, waitedMs: number) {
    super(
      `The Computer Use helper process group ${group} was still alive ${waitedMs}ms after SIGKILL` +
        `${exit?.signal ? ` (launcher exited on ${exit.signal})` : ''}. ` +
        `Inspect it with \`ps -o pid,ppid,command -g ${group}\` and stop that group by hand.`,
    );
    this.name = 'TransportCleanupError';
    this.group = group;
    this.exit = exit;
  }
}

/**
 * A stdio MCP transport that owns the whole process group it starts.
 *
 * A detached guardian leads one group holding the runtime and its descendants.
 * This transport reads and writes that runtime directly over inherited pipes and
 * speaks the SDK's own stdio framing. On close it signals only its own group:
 * SIGTERM, a bounded SIGKILL, then proof the group is gone. It never retries and
 * never replays a message, and it never signals anything it did not start.
 */
export class OwnedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #options: OwnedTransportOptions;
  readonly #buffer = new ReadBuffer();

  #child: ChildProcess | undefined;
  #group: number | undefined;
  #exit: ExitFacts | undefined;
  #launcherClosed = false;
  #started = false;
  #closed = false;
  #reportedClosed = false;
  #closing: Promise<void> | undefined;

  constructor(options: OwnedTransportOptions) {
    this.#options = options;
  }

  /** The guardian pid, which is also the owned process group id. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async start(): Promise<void> {
    // A closed transport is terminal and says so, even if it ran before.
    if (this.#closed) throw new TransportClosedError('The Computer Use helper transport is closed and cannot be started again');
    if (this.#started) throw new Error('OwnedTransport already started');
    this.#started = true;

    const child = spawn(process.execPath, [GUARDIAN_PATH], {
      cwd: this.#options.cwd,
      env: this.#options.env,
      // detached makes the guardian a process-group leader, so `-pid` is ours
      // alone. The runtime inherits the guardian's stdio, so the pipes below
      // carry the runtime's traffic directly. stderr is dropped: helper output
      // can quote screen content.
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
      shell: false,
      windowsHide: true,
    });
    this.#child = child;
    if (child.pid !== undefined) this.#group = child.pid;

    child.stdout?.on('data', chunk => this.#read(chunk as Buffer));
    child.stdout?.on('error', error => this.onerror?.(error));
    child.stdin?.on('error', error => this.onerror?.(error));
    child.once('error', error => this.onerror?.(error));
    child.once('exit', (code, signal) => {
      this.#exit ??= { code, signal };
    });
    child.on('message', (message: { type?: string; code?: number | null; signal?: NodeJS.Signals | null }) => {
      if (message.type === 'exit') {
        this.#exit = { code: message.code ?? null, signal: message.signal ?? null };
        this.#reportClosed();
      }
    });
    child.once('close', () => {
      this.#launcherClosed = true;
      this.#buffer.clear();
      this.#reportClosed();
    });

    await new Promise<void>((resolve, reject) => {
      const settle = (finish: () => void) => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
        child.off('close', onClose);
        finish();
      };
      const onSpawn = () => settle(resolve);
      const onError = (error: Error) => settle(() => reject(error));
      // A child that dies before spawning must not leave start() waiting forever.
      const onClose = () => settle(() => reject(this.#notRunning()));
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('close', onClose);
    });

    if (this.#closed) throw this.#notRunning();
    // The guardian may not have launched the runtime yet. It watches parent IPC
    // loss both before and after launch, so a parent crash always reaps the group.
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        child.off('message', onMessage);
        child.off('close', onClose);
        error ? reject(error) : resolve();
      };
      const onClose = () => finish(this.#notRunning());
      const onMessage = (message: { type?: string; code?: string; message?: string }) => {
        if (message.type === 'started') finish();
        if (message.type === 'error') finish(Object.assign(new Error(message.message), { code: message.code }));
      };
      child.on('message', onMessage);
      child.once('close', onClose);
      child.send(
        { command: this.#options.command, args: this.#options.args, cwd: this.#options.cwd, env: this.#options.env },
        error => {
          if (error) finish(error);
        },
      );
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.#child?.stdin;
    if (this.#closed || !stdin || stdin.destroyed) throw this.#notRunning();
    const payload = serializeMessage(message);
    // Resolving before the write settles would let a caller believe a request
    // was sent when the pipe was already gone.
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, error => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Ends the connection for good: SIGTERM to our group, then a bounded SIGKILL,
   * then proof the group is gone. Idempotent. A group that survives is reported
   * as a failure rather than quietly treated as closed.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    // Nothing was started, so there is no group to prove gone.
    if (!this.#started || !this.#child) {
      this.#reportClosed();
      return;
    }
    const group = this.#group;
    this.#child.stdin?.end();
    if (group === undefined) {
      await this.#waitFor(() => this.#launcherClosed);
      this.#destroy();
      this.#reportClosed();
      return;
    }
    this.#signal(group, 'SIGTERM');
    await this.#waitFor(() => this.#groupGone(), GRACE_MS);
    if (!this.#groupGone()) {
      this.#signal(group, 'SIGKILL');
      await this.#waitFor(() => this.#groupGone());
    }
    await this.#waitFor(() => this.#launcherClosed);
    this.#destroy();
    // The launcher can exit while its descendants keep running, so the launcher
    // is not evidence: only the group itself is.
    if (!this.#groupGone()) throw new TransportCleanupError(group, this.#exit, GRACE_MS + WAIT_MS);
    this.#reportClosed();
  }

  #notRunning(): TransportClosedError {
    const exit = this.#exit;
    const how =
      this.#closed && !this.#started
        ? 'is closed and was never started'
        : exit
          ? `exited with code ${exit.code ?? 'none'}${exit.signal ? ` on ${exit.signal}` : ''}`
          : 'is not running';
    return new TransportClosedError(
      `The Computer Use helper ${how}` + (this.#group === undefined ? '' : ` (process group ${this.#group})`),
      exit,
    );
  }

  /** Signals only our own group. Anything else is never ours to touch. */
  #signal(group: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-group, signal);
    } catch (error) {
      // ESRCH is the outcome we wanted; anything else is worth reporting.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.onerror?.(error as Error);
    }
  }

  /** `true` only when the group has no members left at all. */
  #groupGone(): boolean {
    const group = this.#group;
    if (group === undefined) return this.#launcherClosed;
    try {
      process.kill(-group, 0);
      return false;
    } catch (error) {
      // EPERM means it exists but is not ours to signal: still not gone.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /** Referenced timers keep Node alive until cleanup is proved or times out. */
  async #waitFor(done: () => boolean, ms: number = WAIT_MS): Promise<void> {
    const deadline = performance.now() + ms;
    while (!done()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await delay(Math.min(POLL_MS, remaining));
    }
  }

  #destroy(): void {
    this.#child?.stdout?.destroy();
    this.#child?.stdin?.destroy();
  }

  #read(chunk: Buffer): void {
    let message: JSONRPCMessage | null;
    try {
      this.#buffer.append(chunk);
      while ((message = this.#buffer.readMessage()) !== null) this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  #reportClosed(): void {
    if (this.#reportedClosed) return;
    this.#reportedClosed = true;
    this.onclose?.();
  }
}
