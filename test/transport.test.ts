import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { OwnedTransport } from '../src/transport.ts';

/**
 * A runtime double that never touches the desktop. It publishes its own pid (and
 * optionally a descendant that ignores SIGTERM) to a pidfile, announces itself
 * with one framed notification, and echoes each framed stdin line back on stdout.
 * It deliberately does not exit on stdin EOF, the way the real helper does not.
 */
const RUNTIME = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const pids = { runtime: process.pid };
if (process.env.PI_CUA_T_STUBBORN === '1') {
  const hold = 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});process.stdin.resume();setInterval(()=>{},1000);';
  const grandchild = spawn(process.execPath, ['-e', hold], { stdio: ['ignore', 'ignore', 'ignore'] });
  pids.grandchild = grandchild.pid;
}
if (process.env.PI_CUA_T_PIDFILE) {
  try { writeFileSync(process.env.PI_CUA_T_PIDFILE, JSON.stringify(pids)); } catch {}
}
process.stdout.write('{"jsonrpc":"2.0","method":"ready"}\n');
let buffered = '';
process.stdin.on('data', chunk => {
  buffered += chunk.toString('utf8');
  let index;
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (line.trim().length > 0) process.stdout.write(line + '\n');
  }
});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

/** A process that ignores SIGTERM and SIGINT, used as an outside decoy. */
const HOLDER =
  'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});process.stdin.resume();setInterval(()=>{},1000);';

interface RuntimePids {
  runtime: number;
  grandchild?: number;
}

function tempPath(suffix = ''): string {
  return join(tmpdir(), `pi-cua-owned-${process.pid}-${randomUUID()}${suffix}`);
}

function environment(pidfile: string, stubborn: boolean): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    PI_CUA_T_PIDFILE: pidfile,
    PI_CUA_T_STUBBORN: stubborn ? '1' : '0',
  };
}

function owned(pidfile: string, stubborn = false): OwnedTransport {
  return new OwnedTransport({
    command: process.execPath,
    args: ['-e', RUNTIME],
    cwd: tmpdir(),
    env: environment(pidfile, stubborn),
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10));
}

async function waitFor(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await tick();
  }
}

/** Reads a pidfile that the runtime writes as soon as it starts. */
async function runtimePids(path: string): Promise<RuntimePids> {
  await waitFor(() => existsSync(path));
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RuntimePids;
    } catch {
      await tick();
    }
  }
  throw new Error('the runtime never wrote a readable pidfile');
}

async function pidFrom(path: string): Promise<number> {
  await waitFor(() => existsSync(path));
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(value) && value > 0) return value;
    await tick();
  }
  throw new Error('the pidfile never held a pid');
}

/** Kills a process outright and waits for it, so no test leaves a stray behind. */
async function reap(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 2_000).unref();
    });
  }
}

test('frames SDK messages over the inherited pipes and closes its own group once', async t => {
  const pidfile = tempPath('.json');
  const subject = owned(pidfile);
  t.after(() => subject.close().catch(() => {}));

  const seen: JSONRPCMessage[] = [];
  let closed = 0;
  subject.onmessage = message => seen.push(message);
  subject.onclose = () => {
    closed += 1;
  };

  await subject.start();
  const group = subject.pid;
  assert.equal(typeof group, 'number', 'the guardian pid is the owned group id');
  const pids = await runtimePids(pidfile);
  assert.ok(alive(pids.runtime), 'the runtime is live in the owned group');

  const request: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping', params: { hello: 'world' } };
  await subject.send(request);
  await waitFor(() => seen.some(message => (message as { id?: unknown }).id === 1));
  assert.deepEqual(
    seen.find(message => (message as { id?: unknown }).id === 1),
    request,
    'the reply arrives framed exactly as sent, with no envelope or rewrite',
  );

  await Promise.all([subject.close(), subject.close()]);
  assert.equal(closed, 1, 'onclose fires exactly once across repeated closes');
  await waitFor(() => !alive(-group!));
  assert.equal(alive(-group!), false, 'the owned group is gone after close');
  await assert.rejects(subject.send({ jsonrpc: '2.0', id: 2, method: 'ping' }), /Computer Use helper/);
});

test('closing one transport leaves other sessions and outside processes untouched', async t => {
  const decoy = spawn(process.execPath, ['-e', HOLDER], { stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(() => reap(decoy));
  await waitFor(() => alive(decoy.pid!));

  const fileA = tempPath('.json');
  const fileB = tempPath('.json');
  const first = owned(fileA);
  const second = owned(fileB);
  t.after(() => Promise.allSettled([first.close(), second.close()]));

  await Promise.all([first.start(), second.start()]);
  const groupA = first.pid!;
  const groupB = second.pid!;
  assert.notEqual(groupA, groupB, 'each transport owns its own group');
  const pidsB = await runtimePids(fileB);

  await first.close();
  await waitFor(() => !alive(-groupA));
  assert.equal(alive(-groupA), false, 'the closed group is gone');
  assert.ok(alive(-groupB), 'the other session group survives');
  assert.ok(alive(pidsB.runtime), 'the other session runtime survives');
  assert.ok(alive(decoy.pid!), 'a process outside every owned group survives');

  // The surviving session is still usable, not just alive.
  const seen: JSONRPCMessage[] = [];
  second.onmessage = message => seen.push(message);
  await second.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
  await waitFor(() => seen.some(message => (message as { id?: unknown }).id === 5));

  await second.close();
  await waitFor(() => !alive(-groupB));
});

test('an orphaned group reaps itself, including a descendant that ignores SIGTERM', async t => {
  const pidfile = tempPath('.json');
  const guardianFile = tempPath('.guardian');
  const runner = tempPath('.mjs');
  const transportUrl = new URL('../src/transport.ts', import.meta.url).href;
  writeFileSync(
    runner,
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { OwnedTransport } from ${JSON.stringify(transportUrl)};`,
      `const transport = new OwnedTransport({`,
      `  command: process.execPath,`,
      `  args: ['-e', process.env.PI_CUA_T_RUNTIME],`,
      `  cwd: process.env.PI_CUA_T_CWD,`,
      `  env: { PATH: process.env.PATH ?? '', PI_CUA_T_PIDFILE: process.env.PI_CUA_T_PIDFILE, PI_CUA_T_STUBBORN: '1' },`,
      `});`,
      `await transport.start();`,
      `writeFileSync(process.env.PI_CUA_T_GUARDIAN, String(transport.pid));`,
      `setInterval(() => {}, 1000);`,
      '',
    ].join('\n'),
  );

  const child = spawn(process.execPath, ['--experimental-strip-types', runner], {
    env: {
      ...process.env,
      PI_CUA_T_RUNTIME: RUNTIME,
      PI_CUA_T_CWD: tmpdir(),
      PI_CUA_T_PIDFILE: pidfile,
      PI_CUA_T_GUARDIAN: guardianFile,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  t.after(() => reap(child));

  const pids = await runtimePids(pidfile);
  const group = await pidFrom(guardianFile);
  assert.ok(alive(-group), 'the guardian group is live');
  assert.ok(alive(pids.grandchild!), 'the stubborn descendant is live');

  // Kill the owning parent outright: no close(), no handlers, only IPC EOF left.
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  process.kill(child.pid!, 'SIGKILL');
  await exited;

  await waitFor(() => !alive(-group), 8_000);
  await waitFor(() => !alive(pids.grandchild!), 8_000);
  assert.equal(alive(-group), false, 'the orphaned group reaped itself through IPC EOF');
  assert.equal(alive(pids.grandchild!), false, 'the descendant that ignored SIGTERM is gone');
});

test('close SIGKILLs a descendant that ignores SIGTERM and confirms the group is gone', async t => {
  const pidfile = tempPath('.json');
  const subject = owned(pidfile, true);
  t.after(() => subject.close().catch(() => {}));

  await subject.start();
  const group = subject.pid!;
  const pids = await runtimePids(pidfile);
  assert.ok(alive(pids.grandchild!), 'the stubborn descendant is live before close');

  await subject.close();

  assert.equal(alive(-group), false, 'close reports only a confirmed gone group');
  assert.equal(alive(pids.runtime), false, 'the runtime is gone');
  await waitFor(() => !alive(pids.grandchild!), 5_000);
  assert.equal(alive(pids.grandchild!), false, 'the descendant that ignored SIGTERM is gone');
});

test('reports a spawn failure and still cleans up its own group', async t => {
  const subject = new OwnedTransport({ command: join(tmpdir(), `pi-cua-missing-${randomUUID()}`) });
  t.after(() => subject.close().catch(() => {}));

  const group = subject.pid;
  await assert.rejects(subject.start(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.equal(typeof subject.pid, 'number', 'the guardian exists even when the runtime cannot spawn');

  await subject.close();
  const owned = subject.pid ?? group;
  if (owned !== undefined) assert.equal(alive(-owned), false, 'the failed launch leaves no group behind');
});

test('refuses a second start, and refuses any start or send after close', async t => {
  const subject = new OwnedTransport({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  t.after(() => subject.close().catch(() => {}));

  await subject.start();
  await assert.rejects(subject.start(), /already started/);

  await subject.close();
  await assert.rejects(subject.start(), /Computer Use helper/);
  await assert.rejects(subject.send({ jsonrpc: '2.0', method: 'ping' }), /Computer Use helper/);

  // A transport that never started can still be closed, and cannot then start.
  const never = new OwnedTransport({ command: process.execPath, args: ['-e', ''] });
  await never.close();
  await assert.rejects(never.start(), /Computer Use helper/);
});
