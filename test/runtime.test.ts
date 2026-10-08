import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  COMPUTER_USE_INSTRUCTIONS,
  BROWSER_SERVICE_MODULE,
  SERVICE_BUNDLE_NAME,
  SERVICE_RELATIVE_PATH,
  SKY_SERVICE_MODULE,
  resolveRuntime,
  launchSpec,
  RuntimeError,
  type RuntimeFs,
  type SignatureChecker,
  type Runtime,
} from '../src/runtime.ts';

const APP = '/Applications/ChatGPT.app';
const CUA_NODE = join(APP, 'Contents', 'Resources', 'cua_node');
const MODULES = join(CUA_NODE, 'lib', 'node_modules');
const SKY_DIR = join(MODULES, '@oai', 'sky');
const NODE_REPL = join(CUA_NODE, 'bin', 'node_repl');
const NODE = join(CUA_NODE, 'bin', 'node');
const CODEX = join(APP, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
const LEGACY_CODEX = join(APP, 'Contents', 'Resources', 'codex');
const HOME = '/Users/tester';
const PROJECT_CWD = '/work/project';
const CODEX_HOME_DIR = join(HOME, '.codex');
const INSTALLED_SERVICE = join(HOME, '.codex', 'computer-use', SERVICE_BUNDLE_NAME);
const BUNDLED_SERVICE = join(SKY_DIR, SERVICE_BUNDLE_NAME);
const SOCKET = join(HOME, 'Library', 'Group Containers', '2DC432GLL2.com.openai.sky.CUAService', 'IPC');
const SKY_SKILL = join(SKY_DIR, 'docs', 'skills', 'oai_sky_lib', 'macos', 'SKILL.md');
const SKILL_TEXT = '# Official macOS Sky skill\n\nNative API documentation.';

const MANIFEST = JSON.stringify({
  platform: 'darwin',
  arch: 'arm64',
  node_path: 'bin/node',
  node_modules: 'lib/node_modules',
  node_repl_path: 'bin/node_repl',
});

function fsOf(dirs: readonly string[], execs: readonly string[], texts: Record<string, string> = {}): RuntimeFs {
  const present = new Set(dirs);
  const runnable = new Set(execs);
  return {
    directory: async (path) => present.has(path),
    executable: async (path) => runnable.has(path),
    readText: async (path) => texts[path],
  };
}

/** Baseline signed files: the manifest and the official macOS skill documentation. */
function manifestTexts(extra: Record<string, string> = {}): Record<string, string> {
  return { [join(CUA_NODE, 'manifest.json')]: MANIFEST, [SKY_SKILL]: SKILL_TEXT, ...extra };
}

/** A complete, valid install. Overrides add to the baseline rather than replace it. */
function complete(overrides: { dirs?: string[]; execs?: string[]; texts?: Record<string, string> } = {}): RuntimeFs {
  return fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, SOCKET, ...(overrides.dirs ?? [])],
    [APP, NODE_REPL, NODE, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH), ...(overrides.execs ?? [])],
    manifestTexts(overrides.texts),
  );
}

const okSignature: SignatureChecker = async () => ({
  valid: true,
  teamIdentifier: '2DC432GLL2',
});

function deps(overrides: Partial<Parameters<typeof resolveRuntime>[0]> = {}) {
  return { env: {}, home: HOME, platform: 'darwin' as const, ...overrides };
}

const RUNTIME: Runtime = {
  nodeReplPath: NODE_REPL,
  nodePath: NODE,
  nodeModuleDirectory: MODULES,
  codexPath: CODEX,
  serviceAppPath: INSTALLED_SERVICE,
  socketDirectory: SOCKET,
  cwd: PROJECT_CWD,
  codexHome: CODEX_HOME_DIR,
};

test('resolves the signed runtime with the caller cwd and an independent Codex home', async () => {
  const runtime = await resolveRuntime(deps({ cwd: PROJECT_CWD, fs: complete(), signature: okSignature }));
  assert.equal(runtime.nodeReplPath, NODE_REPL);
  assert.equal(runtime.nodePath, NODE);
  assert.equal(runtime.nodeModuleDirectory, MODULES);
  assert.equal(runtime.codexPath, CODEX);
  assert.equal(runtime.serviceAppPath, INSTALLED_SERVICE);
  assert.equal(runtime.socketDirectory, SOCKET);
  assert.equal(runtime.cwd, PROJECT_CWD);
  assert.equal(runtime.codexHome, CODEX_HOME_DIR);
  assert.equal(runtime.skySkillPath, SKY_SKILL);
  assert.equal('clientPath' in runtime, false);
});

test('requires the official macOS Sky skill documentation to be readable and nonempty', async () => {
  const read: string[] = [];
  const base = complete();
  const recording: RuntimeFs = {
    ...base,
    readText: async (path) => { read.push(path); return base.readText(path); },
  };
  const runtime = await resolveRuntime(deps({ fs: recording, signature: okSignature }));
  assert.equal(runtime.skySkillPath, SKY_SKILL);
  assert.ok(read.includes(SKY_SKILL), 'discovery must read the skill documentation');
});

test('fails closed when the official macOS Sky skill documentation is missing or empty', async () => {
  const missing = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
    { [join(CUA_NODE, 'manifest.json')]: MANIFEST },
  );
  await assert.rejects(resolveRuntime(deps({ fs: missing, signature: okSignature })), (error: RuntimeError) => {
    assert.equal(error.code, 'sky_skill_missing');
    assert.match(error.message, /oai_sky_lib/);
    return true;
  });
  await assert.rejects(resolveRuntime(deps({ fs: complete({ texts: { [SKY_SKILL]: '   \n' } }), signature: okSignature })),
    (error: RuntimeError) => error.code === 'sky_skill_missing');
});

test('defaults the launch cwd to the process working directory', async () => {
  const runtime = await resolveRuntime(deps({ fs: complete(), signature: okSignature }));
  assert.equal(runtime.cwd, process.cwd());
  assert.equal(runtime.codexHome, CODEX_HOME_DIR);
});

test('verifies the outer bundle, node_repl, node, codex, and both service parts', async () => {
  const seen: string[] = [];
  await resolveRuntime(
    deps({
      fs: complete(),
      signature: async (path) => {
        seen.push(path);
        return okSignature(path);
      },
    }),
  );
  assert.deepEqual(
    [...seen].sort(),
    [APP, NODE_REPL, NODE, CODEX, INSTALLED_SERVICE, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)].sort(),
  );
});

test('rejects any platform that is not macOS', async () => {
  await assert.rejects(
    resolveRuntime(deps({ platform: 'linux' as NodeJS.Platform, fs: complete(), signature: okSignature })),
    (error: Error) => error.message.includes('macOS'),
  );
});

test('reports a missing desktop app with every searched location', async () => {
  await assert.rejects(resolveRuntime(deps({ fs: fsOf([], []), signature: okSignature })), (error: Error) => {
    assert.match(error.message, /No ChatGPT or Codex desktop app/);
    assert.match(error.message, /\/Applications\/ChatGPT\.app/);
    return true;
  });
});

test('honors PI_CUA_APP as the only searched bundle', async () => {
  await assert.rejects(
    resolveRuntime(deps({ env: { PI_CUA_APP: '/Applications/Codex.app' }, fs: complete(), signature: okSignature })),
    (error: Error) => {
      assert.match(error.message, /\/Applications\/Codex\.app/);
      assert.doesNotMatch(error.message, /\/Applications\/ChatGPT\.app/);
      return true;
    },
  );
});

test('rejects an invalid signature and a foreign-signing team', async () => {
  await assert.rejects(
    resolveRuntime(deps({ fs: complete(), signature: async () => ({ valid: false }) })),
    (error: Error) => /is not correctly signed/.test(error.message),
  );
  await assert.rejects(
    resolveRuntime(deps({ fs: complete(), signature: async () => ({ valid: true, teamIdentifier: 'TEAM666' }) })),
    (error: Error) => /is signed by TEAM666, expected 2DC432GLL2/.test(error.message),
  );
});

test('fails closed on a missing or bundle-escaping manifest', async () => {
  const noManifest = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
  );
  await assert.rejects(resolveRuntime(deps({ fs: noManifest, signature: okSignature })), (error: Error) =>
    /manifest is missing/.test(error.message),
  );
  await assert.rejects(
    resolveRuntime(
      deps({
        fs: complete({ texts: { [join(CUA_NODE, 'manifest.json')]: JSON.stringify({ node_repl_path: '../../evil', node_path: 'bin/node', node_modules: 'lib/node_modules' }) } }),
        signature: okSignature,
      }),
    ),
    (error: Error) => /escapes the app bundle/.test(error.message),
  );
});

test('fails closed when a manifest binary is missing or not executable', async () => {
  const noNode = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, SOCKET],
    [APP, NODE_REPL, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  await assert.rejects(resolveRuntime(deps({ fs: noNode, signature: okSignature })), (error: Error) =>
    /incomplete: node is missing/.test(error.message),
  );
});

test('fails closed when the trusted @oai/sky module tree is absent', async () => {
  const noSky = fsOf(
    [APP, CUA_NODE, MODULES, INSTALLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  await assert.rejects(resolveRuntime(deps({ fs: noSky, signature: okSignature })), (error: Error) =>
    new RegExp(SKY_SERVICE_MODULE.replace('/', '\\/')).test(error.message),
  );
});

test('fails closed on an incomplete installed service instead of substituting the bundled one', async () => {
  const fs = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, BUNDLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, CODEX, join(BUNDLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  await assert.rejects(resolveRuntime(deps({ fs, signature: okSignature })), (error: Error) => {
    assert.match(error.message, /is incomplete/);
    assert.ok(error.message.includes(INSTALLED_SERVICE));
    assert.ok(!error.message.includes(BUNDLED_SERVICE));
    return true;
  });
});

test('uses the bundled service only when the installed service is absent', async () => {
  const fs = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, BUNDLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, CODEX, join(BUNDLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  const runtime = await resolveRuntime(deps({ fs, signature: okSignature }));
  assert.equal(runtime.serviceAppPath, BUNDLED_SERVICE);
});

test('falls back to the older Resources/codex launcher', async () => {
  const fs = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE, SOCKET],
    [APP, NODE_REPL, NODE, LEGACY_CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  const runtime = await resolveRuntime(deps({ fs, signature: okSignature }));
  assert.equal(runtime.codexPath, LEGACY_CODEX);
});

test('reports a missing IPC directory', async () => {
  const noSocket = fsOf(
    [APP, CUA_NODE, MODULES, SKY_DIR, INSTALLED_SERVICE],
    [APP, NODE_REPL, NODE, CODEX, join(INSTALLED_SERVICE, SERVICE_RELATIVE_PATH)],
    manifestTexts(),
  );
  await assert.rejects(resolveRuntime(deps({ fs: noSocket, signature: okSignature })), (error: Error) =>
    /IPC directory is missing/.test(error.message),
  );
});

test('launchSpec is the verified native-pipe recipe with only the official sky service', () => {
  const spec = launchSpec(RUNTIME, { HOME, PATH: '/usr/bin', LANG: '', OPENAI_API_KEY: 'secret' });
  assert.equal(spec.command, CODEX);
  assert.deepEqual(spec.args, [
    'sandbox',
    '-P',
    ':danger-full-access',
    '--include-managed-config',
    '--allow-unix-socket',
    SOCKET,
    NODE_REPL,
  ]);
  assert.equal(spec.cwd, PROJECT_CWD);
  assert.equal(spec.env.CODEX_HOME, CODEX_HOME_DIR);
  assert.equal(spec.env.SKY_CUA_SERVICE_PATH, INSTALLED_SERVICE);
  assert.equal(spec.env.NODE_REPL_NODE_PATH, NODE);
  assert.equal(spec.env.NODE_REPL_NODE_MODULE_DIRS, MODULES);
  assert.equal(spec.env.NODE_REPL_TRUSTED_CODE_PATHS, MODULES);
  assert.equal(spec.env.NODE_REPL_TRUSTED_SERVICES, JSON.stringify({ sky: SKY_SERVICE_MODULE }));
  assert.equal(spec.env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE, COMPUTER_USE_INSTRUCTIONS);
  assert.equal(spec.env.NODE_REPL_TRUSTED_RPC_ENABLED, '1');
  assert.equal(spec.env.NODE_REPL_DISABLE_ANALYTICS, '1');
  assert.deepEqual(spec.env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(','), ['SKY_CUA_SERVICE_PATH']);
  assert.ok(!spec.args.some((argument) => argument.includes('SkyComputerUseClient')));
});

test('discovers the bundled browser plugin and launches both services without inheriting browser overrides', async () => {
  const root = join(APP, 'Contents', 'Resources', 'plugins', 'openai-bundled', 'plugins', 'browser');
  const browser = {
    skillPath: join(root, 'skills', 'control-in-app-browser', 'SKILL.md'),
    clientPath: join(root, 'scripts', 'browser-client.mjs'),
    version: '27.0101.12345',
  };
  const fixture = {
    dirs: [root, join(MODULES, '@oai', 'browser-desktop')],
    texts: {
      [browser.skillPath]: '# Official Browser skill',
      [browser.clientPath]: 'export function setupBrowserRuntime() {}',
      [join(root, '.codex-plugin', 'plugin.json')]: JSON.stringify({ version: browser.version }),
    },
  };
  const runtime = await resolveRuntime(deps({ fs: complete(fixture), signature: okSignature }));
  assert.deepEqual(runtime.browser, browser);
  const env = launchSpec(runtime, { BROWSER_USE_AVAILABLE_BACKENDS: 'cdp', BROWSER_USE_SECURITY_MODE: 'disabled-for-local-testing' }).env;
  assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), { sky: SKY_SERVICE_MODULE, browser: BROWSER_SERVICE_MODULE });
  assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, browser.version);
  assert.equal(env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR, 'prod');
  assert.equal(env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome');
  assert.equal(env.CUA_REPL_BROWSER_ENV, 'codex-app');
  assert.equal(env.BROWSER_USE_SECURITY_MODE, undefined);
  assert.deepEqual(env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(','), ['SKY_CUA_SERVICE_PATH', 'CUA_REPL_BROWSER_ENV']);
  assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS, MODULES);
  await assert.rejects(resolveRuntime(deps({ fs: complete({ ...fixture, texts: { ...fixture.texts, [browser.skillPath]: '' } }), signature: okSignature })),
    (error: RuntimeError) => error.code === 'browser_incomplete');
  assert.equal((await resolveRuntime(deps({ fs: complete(), signature: okSignature }))).browser, undefined);
});

test('launchSpec carries the official Computer Use instruction value unchanged', () => {
  const spec = launchSpec(RUNTIME, {});
  assert.equal(spec.env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE, 'Control desktop apps on macOS through Computer Use.');
});

test('launchSpec falls back to ~/.codex when the runtime omits codexHome', () => {
  const { codexHome: _omitted, ...withoutCodexHome } = RUNTIME;
  const spec = launchSpec(withoutCodexHome, {});
  assert.equal(spec.cwd, PROJECT_CWD);
  assert.equal(spec.env.CODEX_HOME, join(homedir(), '.codex'));
});

test('launchSpec forwards only present minimal variables and drops secrets', () => {
  const spec = launchSpec(RUNTIME, { HOME, PATH: '/usr/bin', LANG: '', OPENAI_API_KEY: 'secret' });
  assert.equal(spec.env.HOME, HOME);
  assert.equal(spec.env.PATH, '/usr/bin');
  assert.equal(spec.env.LANG, undefined);
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
});

// Requires a real signed OpenAI Computer Use install. Opt-in so the suite stays hermetic.
test('resolveRuntime finds a signed runtime on this machine', { skip: !process.env.PI_CUA_LIVE }, async (t) => {
  const runtime = await resolveRuntime();
  assert.ok(runtime.nodeReplPath.endsWith(join('cua_node', 'bin', 'node_repl')));
  assert.ok(runtime.nodePath.endsWith(join('cua_node', 'bin', 'node')));
  assert.ok(runtime.nodeModuleDirectory.endsWith('node_modules'));
  assert.equal(runtime.cwd, process.cwd());
  assert.equal(runtime.codexHome, join(homedir(), '.codex'));
  assert.ok(runtime.skySkillPath?.endsWith(join('docs', 'skills', 'oai_sky_lib', 'macos', 'SKILL.md')));
  t.diagnostic(`nodeRepl=${runtime.nodeReplPath}`);
});
