import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitRequest,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { launchSpec, type BrowserRuntime, type Runtime } from './runtime.ts';
import { OwnedTransport } from './transport.ts';

export interface Identity {
  sessionId: string;
  turnId: string;
  startedAt: number;
  callId: string;
  model: string;
  reasoningEffort?: string;
}
export type Approve = (request: ElicitRequest['params'], signal: AbortSignal) => Promise<ElicitResult>;
export interface Description {
  /** Official skill from the same verified installation as this runtime. */
  skySkillPath?: string;
  browser?: BrowserRuntime;
  tools: Tool[];
  instructions: string;
  server: { name: string; version: string };
}
export interface Backend {
  readonly connected: boolean;
  open(signal?: AbortSignal): Promise<Description>;
  call(name: string, args: Record<string, unknown>, identity: Identity, approve: Approve, signal?: AbortSignal): Promise<CallToolResult>;
  endTurn(): Promise<void>;
  close(): Promise<void>;
}

/** Protocol failures are not script results. Once sent, no adapter can undo the script. */
export class RequestFailure extends Error {
  readonly outcome: 'not_sent' | 'unknown';
  constructor(message: string, outcome: 'not_sent' | 'unknown', cause?: unknown) {
    super(message, { cause });
    this.name = 'RequestFailure';
    this.outcome = outcome;
  }
}

const STARTUP_MS = 120_000;
// The native REPL owns timeout_ms (including suspended time). Do not replace it
// with an adapter execution deadline. This is Node's largest single timer, used
// only because the MCP SDK always installs a transport watchdog.
const TRANSPORT_WATCHDOG_MS = 2_147_483_647;
const END_TURN_MS = 10_000;

/** One native MCP session. No Sky method table, generated JS, result decoding or observation policy. */
export class NativeClient implements Backend {
  readonly #mcp = new Client({ name: 'pi-cua', version: '0.2.0' }, { capabilities: { elicitation: { form: {} } } });
  readonly #transport: Transport;
  readonly #skySkillPath: string | undefined;
  readonly #browser: BrowserRuntime | undefined;
  readonly #lifetime = new AbortController();
  #description: Description | undefined;
  #opening: Promise<Description> | undefined;
  #closing: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #active: { approve: Approve; signal: AbortSignal } | undefined;
  #turn: Identity | undefined;
  #interrupted = false;
  #connected = false;

  constructor(runtime: Runtime, transport: Transport = new OwnedTransport(launchSpec(runtime))) {
    this.#transport = transport;
    this.#skySkillPath = runtime.skySkillPath;
    this.#browser = runtime.browser;
    this.#mcp.onclose = () => { this.#connected = false; };
    this.#mcp.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const active = this.#active;
      if (!active || active.signal.aborted) return { action: 'decline' };
      const signal = AbortSignal.any([active.signal, extra.signal]);
      try { return await cancelled(active.approve(request.params, signal), signal); }
      catch { return { action: 'decline' }; }
    });
  }

  get connected(): boolean { return this.#connected && !this.#lifetime.signal.aborted; }

  open(signal?: AbortSignal): Promise<Description> {
    this.#lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (!this.#opening) this.#opening = this.#open(signal);
    return this.#opening;
  }

  async #open(signal?: AbortSignal): Promise<Description> {
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    try {
      await this.#mcp.connect(this.#transport, { signal: combined, timeout: STARTUP_MS });
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.#mcp.listTools(cursor ? { cursor } : {}, { signal: combined, timeout: STARTUP_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      if (!tools.some(tool => tool.name === 'js') || !tools.some(tool => tool.name === 'turn_ended')) {
        throw new Error('The official runtime must advertise js and turn_ended. No alternative executor was started.');
      }
      combined.throwIfAborted();
      this.#description = {
        skySkillPath: this.#skySkillPath,
        browser: this.#browser,
        // The official host-only lifecycle hook is not an agent action.
        tools: tools.filter(tool => tool.name !== 'turn_ended'),
        instructions: this.#mcp.getInstructions() ?? '',
        server: this.#mcp.getServerVersion() ?? { name: 'unknown', version: 'unknown' },
      };
      this.#connected = true;
      return this.#description;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Startup failed: ${String(error)}; cleanup failed: ${String(cleanup)}`); }
      throw error;
    }
  }

  call(name: string, args: Record<string, unknown>, identity: Identity, approve: Approve, signal?: AbortSignal): Promise<CallToolResult> {
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    return this.#serial(async () => {
      if (combined.aborted) throw new RequestFailure('Cancelled before dispatch.', 'not_sent', combined.reason);
      if (!this.connected) throw new RequestFailure('The runtime is disconnected. Run /cua on to start a fresh REPL; its old variables cannot be recovered.', 'not_sent');
      if (!this.#description?.tools.some(tool => tool.name === name)) {
        throw new RequestFailure(`The connected runtime does not advertise ${name}.`, 'not_sent');
      }
      this.#active = { approve, signal: combined };
      this.#turn = identity;
      try {
        // Pass the native name, arguments, errors and content through unchanged.
        // A JS exception/timeout is a native result, not a reason to kill the REPL.
        return await this.#mcp.callTool({ name, arguments: args, _meta: metadata(identity) }, undefined, {
          signal: combined, timeout: TRANSPORT_WATCHDOG_MS,
        }) as CallToolResult;
      } catch (error) {
        if (combined.aborted) this.#interrupted = true;
        throw new RequestFailure(`${String(error)} The script may already have acted; it was not replayed.`, 'unknown', error);
      } finally {
        this.#active = undefined;
      }
    });
  }

  endTurn(): Promise<void> {
    return this.#serial(async () => {
      if (this.#lifetime.signal.aborted || !this.#turn) return;
      try { await this.#notifyTurn(); }
      catch (error) {
        // A missing lifecycle acknowledgement is reported, not silently retried.
        // Close this session rather than claim the old turn has been retired.
        try { await this.close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], `Turn end failed: ${String(error)}; cleanup failed: ${String(cleanup)}`); }
        throw new Error(`The runtime did not accept turn_ended; its REPL was closed: ${String(error)}`, { cause: error });
      }
    });
  }

  async #notifyTurn(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    const hook = this.#interrupted ? 'Interrupt' : 'Stop';
    this.#interrupted = false;
    const result = await this.#mcp.callTool({
      name: 'turn_ended',
      arguments: { hook_event_name: hook, session_id: turn.sessionId, turn_id: turn.turnId },
    }, undefined, { timeout: END_TURN_MS }) as CallToolResult;
    if (result.isError) throw new Error(JSON.stringify(result));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#active) this.#interrupted = true;
    this.#lifetime.abort(new Error('Computer Use session closed.'));
    this.#closing = (async () => {
      // Do not await #tail here: close must interrupt a running call, and can be
      // called from endTurn itself. Native request cancellation travels via SDK.
      if (this.#connected && !this.#active) await this.#notifyTurn().catch(() => undefined);
      this.#connected = false;
      const failures: unknown[] = [];
      try { await this.#mcp.close(); } catch (error) { failures.push(error); }
      // SDK close alone is not proof our owned descendants exited.
      try { await this.#transport.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `Computer Use cleanup failed: ${failures.map(String).join('; ')}`);
    })();
    return this.#closing;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export function metadata(identity: Identity): Record<string, unknown> {
  return {
    'x-codex-turn-metadata': {
      session_id: identity.sessionId, thread_id: identity.sessionId, turn_id: identity.turnId,
      turn_started_at_unix_ms: identity.startedAt, call_id: identity.callId, model: identity.model,
      ...(identity.reasoningEffort ? { reasoning_effort: identity.reasoningEffort } : {}),
      sandbox: 'danger-full-access',
    },
    'codex/plugin_id': 'computer-use@openai-bundled',
    threadId: identity.sessionId,
  };
}

async function cancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
