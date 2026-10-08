/**
 * NativeClient wire tests.
 *
 * These tests drive the real `src/client.ts` against a small in-memory MCP
 * fixture that speaks the same `js` / `js_reset` / `js_add_node_module_dir` /
 * `turn_ended` surface as the signed official `node_repl`. The client must pass
 * the runtime's own instructions, schemas, arguments, results and errors through
 * unchanged: this adapter owns transport ownership, cancellation, turn lifecycle
 * and approvals, and nothing else.
 *
 * No process is spawned, no discovery script runs, and no tool other than the
 * fixture's actions is ever invoked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  NativeClient,
  RequestFailure,
  metadata,
  type Approve,
  type Identity,
} from '../src/client.ts';
import type { Runtime } from '../src/runtime.ts';

const RUNTIME: Runtime = {
  nodeReplPath: '/runtime/node_repl',
  nodePath: '/runtime/node',
  nodeModuleDirectory: '/runtime/node_modules',
  codexPath: '/runtime/codex',
  serviceAppPath: '/runtime/Codex Computer Use.app',
  socketDirectory: '/runtime/IPC',
  cwd: '/runtime',
};

const INSTRUCTIONS = 'Control desktop apps on macOS through Computer Use.';

/**
 * The four tools a direct official node_repl advertises, copied verbatim from a
 * live `tools/list`. The client must not rename, re-describe, or re-schema them.
 */
const OFFICIAL_TOOLS: readonly Tool[] = [
  {
    name: 'js',
    description:
      'Execute JavaScript in a persistent `node_repl` with top-level await. Top-level bindings persist until `js_reset` and can be redeclared. Use `const` for stable values and `let` for changing values. Use dynamic imports such as `await import("playwright")`; top-level static imports and `node:process` are unavailable. Use `nodeRepl.write(value)` for output and `await nodeRepl.emitImage(image)` for images. Execution context is available through `nodeRepl.cwd`, `nodeRepl.homeDir`, `nodeRepl.tmpDir`, and `nodeRepl.requestMeta`. The default timeout is 30000 ms (30 seconds); increase `timeout_ms` for longer operations. Use `js_add_node_module_dir` when an additional package directory is required.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        code: { description: 'JavaScript code to execute with top-level await.', type: 'string' },
        timeout_ms: {
          description: 'Optional execution timeout in milliseconds. Defaults to 30000 (30 seconds) when omitted.',
          minimum: 1,
          type: 'integer',
        },
        title: {
          description: 'Short user-facing description of what the code does.',
          maxLength: 80,
          minLength: 1,
          type: 'string',
        },
      },
      required: ['code'],
      type: 'object',
    },
  },
  {
    name: 'js_add_node_module_dir',
    description:
      'Add an absolute `node_modules` directory for package imports. The directory remains available after `js_reset`.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        path: {
          description: 'Absolute path to a node_modules directory to add to Node package resolution.',
          minLength: 1,
          type: 'string',
        },
      },
      required: ['path'],
      type: 'object',
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'js_reset',
    description: 'Reset the JavaScript kernel and clear all bindings.',
    inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'turn_ended',
    description: 'Notify trusted libraries that a Codex turn ended. Repeated notifications for the same session and turn are ignored.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        hook_event_name: { minLength: 1, type: 'string' },
        session_id: { minLength: 1, type: 'string' },
        turn_id: { minLength: 1, type: 'string' },
      },
      required: ['hook_event_name', 'session_id', 'turn_id'],
      type: 'object',
    },
    annotations: { idempotentHint: true },
    _meta: { ui: { visibility: [] } },
  },
];

const IDENTITY: Identity = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  startedAt: 1_700_000_000_000,
  callId: 'call-1',
  model: 'test-model',
  reasoningEffort: 'low',
};

const ACCEPT: Approve = async () => ({ action: 'accept' });

interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
}

interface Fixture {
  client: NativeClient;
  server: Server;
  calls: CallRecord[];
  inits: () => number;
  close: () => Promise<void>;
}

interface FixtureOptions {
  tools?: readonly Tool[];
  instructions?: string;
  onCall?: (request: CallToolRequest, extra: { signal: AbortSignal }, server: Server) => CallToolResult | Promise<CallToolResult>;
}

/** An in-memory official-runtime stand-in; nothing here touches a desktop. */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls: CallRecord[] = [];
  let inits = 0;
  const server = new Server(
    { name: 'fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: options.instructions ?? INSTRUCTIONS },
  );
  server.oninitialized = () => { inits += 1; };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(options.tools ?? OFFICIAL_TOOLS)],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls.push({
      name: request.params.name,
      args: (request.params.arguments ?? {}) as Record<string, unknown>,
      meta: request.params._meta as Record<string, unknown> | undefined,
    });
    if (options.onCall) return await options.onCall(request, extra as { signal: AbortSignal }, server);
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  await server.connect(serverTransport);
  const client = new NativeClient(RUNTIME, clientTransport);
  return {
    client,
    server,
    calls,
    inits: () => inits,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/** Fails the test instead of hanging when teardown waits behind native work. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('open publishes the runtime inventory and instructions verbatim, executing nothing', async () => {
  const f = await fixture();
  try {
    const description = await f.client.open();
    assert.equal(description.instructions, INSTRUCTIONS);
    assert.deepEqual(description.server, { name: 'fixture', version: '1.0.0' });
    assert.deepEqual(description.tools, OFFICIAL_TOOLS.filter(tool => tool.name !== 'turn_ended'));

    // The host-only lifecycle hook is not an agent tool.
    assert.equal(description.tools.some(tool => tool.name === 'turn_ended'), false);

    // js_add_node_module_dir must survive with its own description and schema.
    const addDir = description.tools.find(tool => tool.name === 'js_add_node_module_dir');
    assert.equal(
      addDir?.description,
      'Add an absolute `node_modules` directory for package imports. The directory remains available after `js_reset`.',
    );
    assert.deepEqual(addDir?.inputSchema, OFFICIAL_TOOLS.find(tool => tool.name === 'js_add_node_module_dir')?.inputSchema);

    // Opening must not run a discovery script or any other tool.
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('forwards raw js arguments, including timeout_ms, and per-call turn metadata', async () => {
  const f = await fixture();
  try {
    await f.client.open();
    const result = await f.client.call(
      'js',
      { title: 'probe', code: '1 + 1', timeout_ms: 12_345 },
      IDENTITY,
      ACCEPT,
    );
    assert.equal(result.isError, undefined);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]!.args, { title: 'probe', code: '1 + 1', timeout_ms: 12_345 });
    assert.deepEqual(f.calls[0]!.meta, metadata(IDENTITY));
  } finally {
    await f.close();
  }
});

test('preserves text, image, and structured native results', async () => {
  const image = 'iVBORw0KGgo=';
  const structured = { foo: 'bar', nested: { count: 2 } };
  const f = await fixture({
    onCall: () => ({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: image, mimeType: 'image/png' },
        { type: 'text', text: 'last' },
      ],
      structuredContent: structured,
    }),
  });
  try {
    await f.client.open();
    const result = await f.client.call('js', { code: 'observe()' }, IDENTITY, ACCEPT);
    assert.deepEqual(result.content, [
      { type: 'text', text: 'first' },
      { type: 'image', data: image, mimeType: 'image/png' },
      { type: 'text', text: 'last' },
    ]);
    assert.deepEqual(result.structuredContent, structured);
  } finally {
    await f.close();
  }
});

test('a native isError result is returned without closing the connection', async () => {
  let failing = true;
  const f = await fixture({
    onCall: () =>
      failing
        ? { content: [{ type: 'text', text: 'script blew up' }], isError: true }
        : { content: [{ type: 'text', text: 'fine' }] },
  });
  try {
    await f.client.open();
    const failed = await f.client.call('js', { code: 'throw new Error("x")' }, IDENTITY, ACCEPT);
    assert.equal(failed.isError, true);
    assert.equal(f.client.connected, true);

    failing = false;
    const next = await f.client.call('js', { code: 'ok' }, IDENTITY, ACCEPT);
    assert.equal(next.isError, undefined);
    assert.equal(f.calls.length, 2);
    assert.equal(f.inits(), 1);
  } finally {
    await f.close();
  }
});

test('forwards js_reset on the same connection', async () => {
  const f = await fixture();
  try {
    await f.client.open();
    const result = await f.client.call('js_reset', {}, IDENTITY, ACCEPT);
    assert.equal(result.content[0]!.type, 'text');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.name, 'js_reset');
    assert.deepEqual(f.calls[0]!.args, {});
    assert.equal(f.client.connected, true);
    assert.equal(f.inits(), 1);
  } finally {
    await f.close();
  }
});

test('endTurn notifies once, keeps the connection reusable, and does not duplicate hooks', async () => {
  const f = await fixture();
  try {
    await f.client.open();
    await f.client.call('js', { code: 'let kept = 1' }, IDENTITY, ACCEPT);
    await f.client.endTurn();
    await f.client.endTurn();

    const hooks = f.calls.filter(call => call.name === 'turn_ended');
    assert.equal(hooks.length, 1);
    assert.deepEqual(hooks[0]!.args, {
      hook_event_name: 'Stop',
      session_id: 'session-1',
      turn_id: 'turn-1',
    });

    // Turn end retires service-side state; it does not close or reconnect.
    assert.equal(f.client.connected, true);
    assert.equal(f.inits(), 1);
    const again = await f.client.call('js', { code: 'kept' }, IDENTITY, ACCEPT);
    assert.equal(again.isError, undefined);
  } finally {
    await f.close();
  }
});

test('an aborted call is reported unknown, sends cancellation, and marks the turn interrupted', async () => {
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture({
    onCall: async (request, extra) => {
      if (request.params.arguments?.code === 'hang') {
        reached();
        await new Promise<void>(resolve => {
          if (extra.signal.aborted) return resolve();
          extra.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('cancelled');
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });
  try {
    await f.client.open();
    const controller = new AbortController();
    const pending = f.client.call('js', { code: 'hang' }, IDENTITY, ACCEPT, controller.signal);
    await started;
    controller.abort(new Error('user stopped'));

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RequestFailure);
      assert.equal(error.outcome, 'unknown');
      assert.match(error.message, /not replayed/);
      return true;
    });

    // Cancellation is not a replay: the fixture saw exactly one js call.
    assert.equal(f.calls.filter(call => call.name === 'js').length, 1);

    await f.client.endTurn();
    const hook = f.calls.find(call => call.name === 'turn_ended');
    assert.equal(hook?.args.hook_event_name, 'Interrupt');
  } finally {
    await f.close();
  }
});

test('close during a blocked active call completes without an in-band turn end', async () => {
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture({
    onCall: async (request, extra) => {
      if (request.params.arguments?.code === 'hang') {
        reached();
        await new Promise<void>(resolve => {
          if (extra.signal.aborted) return resolve();
          extra.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('cancelled');
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });
  await f.client.open();
  const pending = f.client.call('js', { code: 'hang' }, IDENTITY, ACCEPT);
  await started;

  // Teardown must not wait behind the blocked script: skip the in-band turn end
  // while a call is active and let SDK cancellation interrupt it instead.
  await withDeadline(f.client.close(), 5_000, 'close did not complete while a call was active');

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RequestFailure);
    assert.equal(error.outcome, 'unknown');
    assert.match(error.message, /not replayed/);
    return true;
  });

  // Interrupted, not replayed, and no lifecycle call was queued behind the script.
  assert.equal(f.calls.filter(call => call.name === 'js').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'turn_ended').length, 0);
  assert.equal(f.client.connected, false);
});

test('approval requests are answered only while a call is active', async () => {
  const seen: string[] = [];
  const f = await fixture({
    onCall: async (_request, _extra, server) => {
      const elicited = await server.elicitInput({
        message: 'Allow Computer Use to use "Test App"?',
        requestedSchema: { type: 'object', properties: {} },
      });
      seen.push(elicited.action);
      return { content: [{ type: 'text', text: 'acted' }] };
    },
  });
  try {
    await f.client.open();
    const approve: Approve = async request => {
      seen.push(`asked:${request.message}`);
      return { action: 'accept' };
    };
    await f.client.call('js', { code: 'act' }, IDENTITY, approve);
    assert.deepEqual(seen, ['asked:Allow Computer Use to use "Test App"?', 'accept']);

    // With no call in flight there is no approval to reuse: the request is declined.
    const orphan = await f.server.elicitInput({
      message: 'orphan request',
      requestedSchema: { type: 'object', properties: {} },
    });
    assert.equal(orphan.action, 'decline');
  } finally {
    await f.close();
  }
});

test('unknown tool names are rejected before dispatch', async () => {
  const f = await fixture();
  try {
    await f.client.open();
    await assert.rejects(f.client.call('not_a_tool', {}, IDENTITY, ACCEPT), (error: unknown) => {
      assert.ok(error instanceof RequestFailure);
      assert.equal(error.outcome, 'not_sent');
      return true;
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('a runtime missing js or turn_ended is rejected and closed', async () => {
  const f = await fixture({ tools: OFFICIAL_TOOLS.filter(tool => tool.name !== 'turn_ended') });
  try {
    await assert.rejects(f.client.open(), (error: unknown) => {
      assert.match(String(error), /must advertise js and turn_ended/);
      return true;
    });
    assert.equal(f.client.connected, false);
    await assert.rejects(f.client.call('js', { code: '1' }, IDENTITY, ACCEPT), (error: unknown) => {
      assert.ok(error instanceof RequestFailure);
      assert.equal(error.outcome, 'not_sent');
      return true;
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
