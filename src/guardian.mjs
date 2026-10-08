// Owned process-group guardian.
//
// It is spawned detached, so it leads a process group of its own and every
// signal it sends with a negative pid reaches exactly that group: the runtime it
// launches, that runtime's descendants, and nothing else. The shared Sky service
// and any other pi-cua session live in other groups and are never touched.
//
// The runtime it launches inherits this guardian's stdin/stdout, so JSON-RPC
// flows directly between the parent and the runtime; the guardian never proxies
// bytes. The one monitored IPC channel is the parent's heartbeat: its EOF means
// the parent is gone, and the guardian then reaps its own group. That is what
// covers a parent that is SIGKILLed and can no longer run any cleanup of its own.
import { spawn } from 'node:child_process';

/** How long a signalled descendant gets to exit before SIGKILL. */
const GRACE_MS = 400;

let stopping = false;

function send(message) {
  try {
    if (process.connected) process.send?.(message);
  } catch {
    // The parent is gone; the disconnect handler is already stopping the group.
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    // The group is already gone.
  }
  // The guardian is a member of its own group, so this SIGTERM reaches it and its
  // handler keeps it alive. The timer stays referenced on purpose: for an
  // orphaned group there is no parent left to escalate, so the guardian itself
  // must survive long enough to SIGKILL a descendant that ignored SIGTERM.
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }, GRACE_MS);
}

process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

process.once('message', spec => {
  if (stopping || !process.connected) return;
  if (!spec || typeof spec.command !== 'string' || spec.command.length === 0) {
    send({ type: 'error', code: 'invalid_spec', message: 'the launch spec has no command' });
    stop();
    return;
  }

  let child;
  try {
    child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env,
      // Not detached: the runtime stays in this guardian's group, so one group
      // signal owns the runtime and everything it spawns.
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'ignore'],
    });
  } catch (error) {
    send({ type: 'error', code: error?.code, message: error?.message ?? String(error) });
    stop();
    return;
  }

  child.once('spawn', () => send({ type: 'started' }));
  child.once('error', error => {
    send({ type: 'error', code: error.code, message: error.message });
    stop();
  });
  child.once('exit', (code, signal) => {
    send({ type: 'exit', code, signal });
    stop();
  });
});
