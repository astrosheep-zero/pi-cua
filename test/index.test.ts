import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createCuaExtension, present } from '../src/index.ts';
import type { Approve, Backend, Description, Identity } from '../src/client.ts';

const tools: Tool[] = [
  { name: 'js', description: 'Official JavaScript description.', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Official code description.' } }, required: ['code'], additionalProperties: false } },
  { name: 'js_reset', description: 'Official reset description.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'js_add_node_module_dir', description: 'Official package import description.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
class FakeBackend implements Backend {
  connected = false;
  closes = 0;
  turns = 0;
  calls: { name: string; args: Record<string, unknown>; identity: Identity }[] = [];
  approve: Approve | undefined;
  result: CallToolResult = { content: [{ type: 'text', text: 'native result' }] };
  closeFailure = false;
  openGate: Promise<void> | undefined;
  browser: Description['browser'];
  async open(signal?: AbortSignal): Promise<Description> {
    await this.openGate;
    signal?.throwIfAborted();
    this.connected = true;
    return { tools, browser: this.browser, skySkillPath: '/signed/sky/docs/skills/oai_sky_lib/macos/SKILL.md', instructions: 'Official server instructions.', server: { name: 'native', version: '1' } };
  }
  async call(name: string, args: Record<string, unknown>, identity: Identity, approve: Approve): Promise<CallToolResult> {
    this.calls.push({ name, args, identity });
    this.approve = approve;
    return this.result;
  }
  async endTurn() { this.turns++; }
  async close() { this.closes++; this.connected = false; if (this.closeFailure) throw new Error('owned child still alive'); }
}

function harness(backend = new FakeBackend()) {
  const session = SessionManager.inMemory('/tmp');
  const registrations = new Map<string, ToolDefinition>();
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const notices: string[] = [];
  let active = ['read'];
  let created = 0;
  let factoryGate: Promise<void> | undefined;
  let command!: (args: string, ctx: any) => Promise<void>;
  const api = {
    registerTool(tool: ToolDefinition) { registrations.set(tool.name, tool); },
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
    on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = names; },
    appendEntry(type: string, data: unknown) { session.appendCustomEntry(type, data); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/tmp', sessionManager: session, model: { id: 'fixture' }, thinkingLevel: 'high', hasUI: true,
    ui: { notify(text: string) { notices.push(text); } },
  } as unknown as ExtensionToolContext;
  createCuaExtension({ createBackend: async cwd => { assert.equal(cwd, '/tmp'); await factoryGate; created++; return backend; } })(api);
  return {
    backend, registrations, notices, session, ctx,
    get active() { return active; }, get created() { return created; },
    /** Holds the next backend factory unresolved, exposing the pre-adoption window. */
    gateFactory() {
      let release!: () => void;
      factoryGate = new Promise<void>(resolve => { release = resolve; });
      return release;
    },
    command: (args: string) => command(args, ctx),
    async emit(event: string, payload: any = {}) { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); },
    async call(name = 'cua_js', args: Record<string, unknown> = { code: 'var x = 1' }) {
      return registrations.get(name)!.execute('call-1', args, undefined, undefined, ctx);
    },
  };
}

test('load and status are inert; on publishes the actual native schemas and descriptions', async () => {
  const h = harness();
  assert.equal(h.created, 0);
  await h.command('status');
  assert.equal(h.created, 0);
  await h.command('on');
  assert.equal(h.created, 1);
  assert.deepEqual(h.active, ['read', ...tools.map(tool => 'cua_' + tool.name)]);
  for (const tool of tools) {
    const exposed = h.registrations.get('cua_' + tool.name)!;
    assert.equal(exposed.exposure, 'direct');
    assert.equal(exposed.description, tool.description);
    assert.deepEqual(exposed.parameters, tool.inputSchema);
    assert.deepEqual(exposed.annotations, tool.annotations);
    assert.equal(exposed.namespace, undefined);
    assert.deepEqual(exposed.outputSchema, {
      type: 'object', properties: { content: { type: 'array' } }, required: ['content'],
    });
  }
  await h.command('on');
  assert.equal(h.created, 1);
  const event = { systemPromptOptions: { promptGuidelines: [] as string[] } };
  await h.emit('before_agent_start', event);
  assert.ok(event.systemPromptOptions.promptGuidelines.includes('Official server instructions.'));
  assert.ok(event.systemPromptOptions.promptGuidelines.some(line =>
    line.includes('read the entire official skill') && line.includes('/signed/sky/docs/skills/oai_sky_lib/macos/SKILL.md')));
  await h.command('off');
  const disabled = { systemPromptOptions: { promptGuidelines: [] as string[] } };
  await h.emit('before_agent_start', disabled);
  assert.deepEqual(disabled.systemPromptOptions.promptGuidelines, []);
});

test('browser instructions use the discovered official paths and Chrome-only host mapping', async () => {
  const h = harness();
  h.backend.browser = { skillPath: '/signed/browser/SKILL.md', clientPath: '/signed/browser/scripts/browser-client.mjs', version: 'test' };
  await h.command('on');
  const event = { systemPromptOptions: { promptGuidelines: [] as string[] } };
  await h.emit('before_agent_start', event);
  const prompt = event.systemPromptOptions.promptGuidelines.join('\n');
  assert.match(prompt, /\/signed\/browser\/SKILL.md/);
  assert.match(prompt, /\/signed\/browser\/scripts\/browser-client.mjs/);
  assert.match(prompt, /only the Chrome extension backend/);
  assert.match(prompt, /cua_js/);
  assert.match(prompt, /@options/);
  assert.match(prompt, /@oai\/sky/);
  assert.equal(h.registrations.size, 3);
});

test('arbitrary raw JS goes through; no observation gate; a healthy backend survives agent_end', async () => {
  const h = harness();
  await h.command('on');
  await h.emit('agent_start');
  const args = { code: 'await sky.set_value({app:"x",element_index:1,value:"a"}); await sky.click({app:"x",element_index:2});', timeout_ms: 240000 };
  await h.call('cua_js', args);
  const firstTurn = h.backend.calls[0].identity.turnId;
  await h.emit('agent_end');
  assert.equal(h.backend.closes, 0);
  assert.equal(h.backend.turns, 1);
  await h.emit('agent_start');
  await h.call('cua_js', { code: 'nodeRepl.write(sky)' });
  assert.notEqual(h.backend.calls[1].identity.turnId, firstTurn);
  assert.equal(h.created, 1);
  assert.deepEqual(h.backend.calls[0].args, args);
  await h.call('cua_js_reset', {});
  assert.equal(h.backend.calls.at(-1)?.name, 'js_reset');
});

test('automatic app approval is announced once per session without echoing the question', async () => {
  const h = harness();
  await h.command('on');
  await h.call();
  const request = { message: 'Allow Computer Use to use "Google Chrome"?', requestedSchema: { type: 'object' as const, properties: {} } };
  const signal = new AbortController().signal;
  const approve = () => h.backend.approve!(request, signal);
  assert.equal((await h.backend.approve!(request, AbortSignal.abort())).action, 'decline');
  assert.equal((await h.backend.approve!({ ...request, requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } }, signal)).action, 'decline');
  assert.equal((await approve()).action, 'accept');
  assert.equal((await approve()).action, 'accept');
  assert.equal((await h.backend.approve!({ ...request, message: 'Allow Computer Use to use "Safari"?' }, signal)).action, 'accept');
  await h.command('off');
  await h.command('on');
  await h.call();
  assert.equal((await approve()).action, 'accept');
  assert.deepEqual(h.notices.filter(text => text.startsWith('Computer Use app access')), [
    'Computer Use app access automatically approved for this session.',
  ]);
});

test('native errors are returned without heuristic stop detection or REPL destruction', async () => {
  const h = harness();
  await h.command('on');
  h.backend.result = { isError: true, content: [{ type: 'text', text: 'Error: userStoppedSession appeared in a script exception' }] };
  const result = await h.call();
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, h.backend.result);
  assert.equal(h.backend.closes, 0);
  assert.ok(h.active.includes('cua_js'));
});

test('off withdraws tools, persists the switch, and closes only this backend', async () => {
  const h = harness();
  await h.command('on');
  await h.command('off');
  assert.equal(h.backend.closes, 1);
  assert.deepEqual(h.active, ['read']);
  assert.equal(h.registrations.get('cua_js')?.exposure, 'hidden');
  assert.equal((h.session.getBranch().at(-1) as any).data.enabled, false);
});

test('off still closes the runtime when saving authorization fails', async t => {
  const h = harness();
  await h.command('on');
  t.mock.method(h.session, 'appendCustomEntry', () => { throw new Error('session write failed'); });
  await h.command('off');
  assert.equal(h.backend.connected, false);
  assert.equal(h.backend.closes, 1);
  assert.deepEqual(h.active, ['read']);
  assert.match(h.notices.at(-1)!, /session write failed/);
});

test('off during startup cancels publication and cleans the starting runtime', async () => {
  let release!: () => void;
  const backend = new FakeBackend();
  backend.openGate = new Promise(resolve => { release = resolve; });
  const h = harness(backend);
  const starting = h.command('on');
  await new Promise(resolve => setTimeout(resolve, 0));
  const stopped = h.command('off');
  release();
  await Promise.all([starting, stopped]);
  assert.ok(backend.closes >= 1);
  assert.deepEqual(h.active, ['read']);
  assert.equal(backend.connected, false);
});

test('on/off/on while startup is pending starts a fresh runtime instead of the aborted attempt', async () => {
  const h = harness();
  const release = h.gateFactory();
  const first = h.command('on');
  await new Promise(resolve => setImmediate(resolve));
  const stopped = h.command('off');
  const second = h.command('on');
  release();
  await Promise.all([first, stopped, second]);
  assert.equal(h.created, 2, 'the second enable must not be short-circuited by the aborted first attempt');
  assert.equal(h.backend.connected, true);
  assert.ok(h.active.includes('cua_js'));
});

test('a cleanup failure from a start abandoned before adoption blocks replacement', async () => {
  const h = harness();
  h.backend.closeFailure = true;
  const release = h.gateFactory();
  const first = h.command('on');
  await new Promise(resolve => setImmediate(resolve));
  const stopped = h.command('off');
  release();
  await Promise.all([first, stopped]);
  assert.equal(h.created, 1);
  assert.ok(h.notices.some(text => /owned child still alive/.test(text)), 'the unproven group must be reported');
  await h.command('on');
  assert.equal(h.created, 1, 'no replacement while the abandoned helper is unproven gone');
  assert.deepEqual(h.active, ['read']);
});

test('cleanup failure remains visible and cannot silently start another child', async () => {
  const h = harness();
  await h.command('on');
  h.backend.closeFailure = true;
  await h.command('off');
  await h.command('on');
  assert.equal(h.created, 1);
  assert.match(h.notices.at(-1)!, /owned child still alive/);
});

test('session reload restores opt-in with a fresh runtime; branch navigation does not reset live bindings', async () => {
  const h = harness();
  await h.command('on');
  await h.emit('session_start');
  assert.equal(h.created, 2);
  const closes = h.backend.closes;
  await h.emit('session_tree');
  assert.equal(h.created, 2);
  assert.equal(h.backend.closes, closes);
  await h.emit('session_shutdown');
  assert.equal(h.backend.connected, false);
});

test('native text, image, resource and metadata remain in the structured result', () => {
  const raw: CallToolResult = { content: [
    { type: 'text', text: 'exact text' },
    { type: 'image', data: 'AQID', mimeType: 'image/png' },
    { type: 'resource_link', name: 'file', uri: 'file:///tmp/result' },
  ], structuredContent: { x: 1 }, _meta: { native: true } };
  const result = present(raw);
  assert.deepEqual(result.structuredContent, raw);
  assert.deepEqual(result.content.slice(0, 2), raw.content.slice(0, 2));
  assert.match((result.content[2] as { text: string }).text, /file:\/\/\/tmp\/result/);
});
