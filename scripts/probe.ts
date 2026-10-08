// Protocol + JavaScript parity probe. No inventory, screenshots, or desktop actions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NativeClient, type Identity } from '../src/client.ts';
import { resolveRuntime } from '../src/runtime.ts';

const client = new NativeClient(await resolveRuntime());
const identity: Identity = {
  sessionId: `pi-cua-probe-${process.pid}`, turnId: 'probe-1', startedAt: Date.now(),
  model: 'local-verification', callId: 'probe',
};
const deny = async () => ({ action: 'decline' as const });
const js = (code: string, extra: Record<string, unknown> = {}) => client.call('js', { code, ...extra }, identity, deny);
const text = (result: Awaited<ReturnType<typeof js>>) => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
try {
  const info = await client.open();
  assert.ok(info.skySkillPath);
  const skill = await readFile(info.skySkillPath, 'utf8');
  assert.match(skill, /## API surface/);
  assert.match(skill, /nodeRepl.emitImage/);
  assert.ok(info.tools.some(tool => tool.name === 'js_reset'));
  assert.ok(info.tools.some(tool => tool.name === 'js_add_node_module_dir'));
  console.log(JSON.stringify({ phase: 'protocol', server: info.server, tools: info.tools.map(tool => tool.name) }));
  const first = await js('var parity = { count: 40, steps: [] }; parity.steps.push("set_value"); parity.steps.push("click"); nodeRepl.write(JSON.stringify(parity));');
  assert.ok(!first.isError, text(first));
  assert.match(text(first), /set_value.*click/);
  await client.endTurn();
  identity.turnId = 'probe-2';
  const second = await js('parity.count += 2; var skyModule = await import("@oai/sky"); nodeRepl.write(JSON.stringify({ count: parity.count, methods: Object.keys(skyModule.sky) }));');
  assert.match(text(second), /"count":42/);
  assert.match(text(second), /get_app_state/);
  console.log(JSON.stringify({ phase: 'persistent-repl', acrossTurn: true, skyImport: true, desktopActions: 0 }));

  const failed = await js('throw new Error("parity-script-error")');
  assert.equal(failed.isError, true);
  assert.match(text(await js('nodeRepl.write(parity.count)')), /42/);
  const reset = await client.call('js_reset', {}, identity, deny);
  assert.ok(!reset.isError);
  assert.match(text(await js('nodeRepl.write(typeof parity)')), /undefined/);
  console.log(JSON.stringify({ phase: 'native-errors-and-reset', scriptErrorPreservesBindings: true, explicitResetClearsBindings: true }));
} finally {
  await client.close();
  console.log(JSON.stringify({ phase: 'cleanup', ok: true }));
}
