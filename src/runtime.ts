/**
 * Official Codex Computer Use runtime: discovery, provenance, and launch.
 *
 * `resolveRuntime` finds the signed ChatGPT/Codex `cua_node` tree and the
 * installed or bundled Sky service, verifies every executable it returns, and
 * reads no desktop state. `launchSpec` turns that into the verified native-pipe
 * recipe: the signed Codex CLI sandbox launches `node_repl`, which reaches Sky
 * over the official IPC socket.
 *
 * Discovery runs `codesign` subprocesses to establish provenance. It launches no
 * runtime, probes no GUI, and changes no system policy.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** OpenAI's Developer ID team. Every executable we launch must carry it. */
export const OPENAI_TEAM_ID = '2DC432GLL2';

/** Codex group container that owns the Sky Computer Use IPC socket. */
export const SKY_GROUP_CONTAINER = '2DC432GLL2.com.openai.sky.CUAService';

/** Official services loaded from the verified module tree. */
export const SKY_MODULE_DIR = join('@oai', 'sky');
export const SKY_SERVICE_MODULE = '@oai/sky/service';
export const BROWSER_SERVICE_MODULE = '@oai/browser-desktop/service';

export interface BrowserRuntime {
  skillPath: string;
  clientPath: string;
  version: string;
}

/** Sky service bundle, either installed under CODEX_HOME or shipped in the app. */
export const SERVICE_BUNDLE_NAME = 'Codex Computer Use.app';
export const SERVICE_RELATIVE_PATH = join('Contents', 'MacOS', 'SkyComputerUseService');

/**
 * Official desktop value for the Computer Use use case. The ChatGPT/Codex app
 * sets `NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE` to exactly this string on
 * macOS when Computer Use is enabled. It is the product's own wording, not a
 * rewritten tool description.
 */
export const COMPUTER_USE_INSTRUCTIONS = 'Control desktop apps on macOS through Computer Use.';

const CUA_NODE_RELATIVE_PATH = join('Contents', 'Resources', 'cua_node');
const MANIFEST_NAME = 'manifest.json';
/** Official macOS API documentation shipped inside the Sky module tree. */
const SKY_SKILL_RELATIVE_PATH = join('docs', 'skills', 'oai_sky_lib', 'macos', 'SKILL.md');
/** Current builds wrap the CLI in an app bundle; older builds ship it directly. */
const CODEX_RELATIVE_PATHS = [
  join('Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
  join('Contents', 'Resources', 'codex'),
] as const;

export interface Runtime {
  /** Signed `node_repl` MCP stdio server that hosts the Sky execution layer. */
  nodeReplPath: string;
  /** Signed Node binary used by that server. */
  nodePath: string;
  /** Signed module tree; the sole entry of `NODE_REPL_TRUSTED_CODE_PATHS`. */
  nodeModuleDirectory: string;
  /** Signed Codex CLI that applies the sandbox to `node_repl`. */
  codexPath: string;
  serviceAppPath: string;
  socketDirectory: string;
  /** Launch working directory: the Pi project's cwd, owned by the caller. */
  cwd: string;
  /**
   * Codex home for the launched runtime. Optional so simple test fixtures can
   * omit it; `launchSpec` then falls back to `~/.codex`.
   */
  codexHome?: string;
  /**
   * Official macOS Sky skill documentation shipped in the signed module tree.
   * Optional so injected fixtures can omit it; real discovery requires a
   * readable, nonempty file so the model is never enabled blind.
   */
  skySkillPath?: string;
  /** Optional official browser plugin from the same verified app bundle. */
  browser?: BrowserRuntime;
}

export interface SignatureFacts {
  /** True when `codesign` accepted the path as unmodified. */
  valid: boolean;
  /** `TeamIdentifier=` value, when reported. */
  teamIdentifier?: string;
}

/** Filesystem predicates, injected so discovery stays pure and testable. */
export interface RuntimeFs {
  executable(path: string): Promise<boolean>;
  directory(path: string): Promise<boolean>;
  readText(path: string): Promise<string | undefined>;
}

export type SignatureChecker = (path: string) => Promise<SignatureFacts>;

export interface RuntimeDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Launch working directory. Defaults to the process working directory. */
  cwd?: string;
  fs?: RuntimeFs;
  signature?: SignatureChecker;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

const defaultFs: RuntimeFs = {
  async executable(path) {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async directory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** A bounded guard against a hung `codesign`, not a limit on what is trusted. */
const CODESIGN_TIMEOUT_MS = 15_000;
const CODESIGN_MAX_BUFFER_BYTES = 1 << 20;

/**
 * Verifies a bundle or executable is intact and reports its signing identity.
 * Plain JS module resources are not individually signed: they are covered by the
 * outer bundle's sealed resources, so bundle-level verification is the correct
 * granularity for the module tree.
 */
export const codesignChecker: SignatureChecker = async (path) => {
  const options = { timeout: CODESIGN_TIMEOUT_MS, maxBuffer: CODESIGN_MAX_BUFFER_BYTES, encoding: 'utf8' } as const;
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', path], options);
  } catch (error) {
    throw new RuntimeError('signature_invalid', `${path} is not correctly signed`, { cause: error });
  }
  // `codesign -dv` reports on stderr, not stdout.
  const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', path], options).catch(
    (error: { stderr?: string }) => ({ stderr: error.stderr ?? '' }),
  );
  const teamIdentifier = /^TeamIdentifier=(.*)$/m.exec(stderr)?.[1]?.trim();
  return { valid: true, teamIdentifier };
};

/** Reject invalid or foreign-signed bundles, including injected checker results. */
async function verify(check: SignatureChecker, path: string): Promise<void> {
  const facts = await check(path);
  if (!facts.valid) throw new RuntimeError('signature_invalid', `${path} is not correctly signed`);
  if (facts.teamIdentifier !== OPENAI_TEAM_ID) {
    throw new RuntimeError(
      'signature_team_mismatch',
      `${path} is signed by ${facts.teamIdentifier ?? 'an unknown team'}, expected ${OPENAI_TEAM_ID}`,
    );
  }
}

async function firstDirectory(fs: RuntimeFs, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await fs.directory(candidate)) return candidate;
  return undefined;
}

async function firstExecutable(fs: RuntimeFs, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await fs.executable(candidate)) return candidate;
  return undefined;
}

function bundleCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  // `PI_CUA_APP` selects a nonstandard official app bundle; it never bypasses
  // verification or enables another backend, so it replaces the search entirely.
  const override = env.PI_CUA_APP;
  if (override) return [override];
  return [
    join('/Applications', 'ChatGPT.app'),
    join('/Applications', 'Codex.app'),
    join(home, 'Applications', 'ChatGPT.app'),
    join(home, 'Applications', 'Codex.app'),
  ];
}

type CuaNodeManifest = { node_path?: unknown; node_modules?: unknown; node_repl_path?: unknown };

async function readManifest(fs: RuntimeFs, manifestPath: string): Promise<CuaNodeManifest> {
  const raw = await fs.readText(manifestPath);
  if (raw === undefined) {
    throw new RuntimeError('manifest_missing', `Computer Use runtime manifest is missing at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeError('manifest_invalid', `Computer Use runtime manifest is unreadable`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RuntimeError('manifest_invalid', `Computer Use runtime manifest is not an object`);
  }
  return parsed as CuaNodeManifest;
}

/** Manifest entries must stay inside the signed bundle: no absolute or escaping paths. */
function manifestEntry(manifest: CuaNodeManifest, key: keyof CuaNodeManifest): string {
  const value = manifest[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeError('manifest_invalid', `Computer Use runtime manifest is missing "${key}"`);
  }
  if (value.startsWith('/') || value.split(/[\\/]/).includes('..')) {
    throw new RuntimeError('manifest_invalid', `Computer Use runtime manifest "${key}" escapes the app bundle`);
  }
  return value;
}

/**
 * Discovery step. Finds the signed Node runtime, the signed Codex CLI launcher,
 * the Sky service bundle, the official macOS skill documentation, and the IPC
 * directory. It verifies provenance (via `codesign`) and reads signed files; it
 * launches no runtime and touches no GUI.
 */
export async function resolveRuntime(deps: RuntimeDeps = {}): Promise<Runtime> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const fs = deps.fs ?? defaultFs;
  const check = deps.signature ?? codesignChecker;

  if (platform !== 'darwin') {
    throw new RuntimeError('unsupported_platform', 'Codex Computer Use requires macOS');
  }

  const apps = bundleCandidates(env, home);
  const appPath = await firstDirectory(fs, apps);
  if (!appPath) {
    throw new RuntimeError('app_not_found', `No ChatGPT or Codex desktop app found (looked in ${apps.join(', ')})`);
  }
  // Verifying the outer bundle also covers the sealed, unsigned cua_node resources.
  await verify(check, appPath);

  const cuaNode = join(appPath, CUA_NODE_RELATIVE_PATH);
  if (!(await fs.directory(cuaNode))) {
    throw new RuntimeError('cua_node_missing', `The signed Computer Use runtime is missing at ${cuaNode}; update the desktop app`);
  }
  const manifest = await readManifest(fs, join(cuaNode, MANIFEST_NAME));
  const nodeReplPath = join(cuaNode, manifestEntry(manifest, 'node_repl_path'));
  const nodePath = join(cuaNode, manifestEntry(manifest, 'node_path'));
  const nodeModuleDirectory = join(cuaNode, manifestEntry(manifest, 'node_modules'));

  for (const [label, path] of [['node_repl', nodeReplPath], ['node', nodePath]] as const) {
    if (!(await fs.executable(path))) {
      throw new RuntimeError(
        'cua_node_incomplete',
        `The signed Computer Use runtime is incomplete: ${label} is missing or not executable at ${path}`,
      );
    }
  }
  await verify(check, nodeReplPath);
  await verify(check, nodePath);

  // Only the bundled, signed @oai/sky tree is trusted for execution.
  if (!(await fs.directory(nodeModuleDirectory))) {
    throw new RuntimeError('modules_missing', `The trusted module directory is missing at ${nodeModuleDirectory}`);
  }
  const skyDir = join(nodeModuleDirectory, SKY_MODULE_DIR);
  if (!(await fs.directory(skyDir))) {
    throw new RuntimeError('sky_missing', `${SKY_SERVICE_MODULE} is not present in the trusted module directory at ${skyDir}`);
  }
  // The official macOS skill documentation is part of the runtime the model is
  // told to use. A missing or empty file is fatal: never enable Computer Use
  // with no real API documentation behind the exposed tools.
  const skySkillPath = join(skyDir, SKY_SKILL_RELATIVE_PATH);
  if (!(await fs.readText(skySkillPath))?.trim()) {
    throw new RuntimeError(
      'sky_skill_missing',
      `The official Sky skill documentation is missing or empty at ${skySkillPath}; update the desktop app`,
    );
  }

  const codexPaths = CODEX_RELATIVE_PATHS.map((relative) => join(appPath, relative));
  const codexPath = await firstExecutable(fs, codexPaths);
  if (!codexPath) {
    throw new RuntimeError('codex_not_found', `Codex CLI is missing (looked in ${codexPaths.join(', ')})`);
  }
  await verify(check, codexPath);

  const installedService = join(home, '.codex', 'computer-use', SERVICE_BUNDLE_NAME);
  const bundledService = join(skyDir, SERVICE_BUNDLE_NAME);
  let serviceAppPath: string | undefined;
  for (const candidate of [installedService, bundledService]) {
    if (!(await fs.directory(candidate))) continue;
    const serviceExecutable = join(candidate, SERVICE_RELATIVE_PATH);
    // A present-but-incomplete service is fatal. Never fall through to another
    // candidate: a broken install must not be silently replaced by a different
    // binary than discovery selected.
    if (!(await fs.executable(serviceExecutable))) {
      throw new RuntimeError(
        'service_incomplete',
        `Codex Computer Use at ${candidate} is incomplete; reinstall Computer Use from the desktop app`,
      );
    }
    await verify(check, candidate);
    await verify(check, serviceExecutable);
    serviceAppPath = candidate;
    break;
  }
  if (!serviceAppPath) {
    throw new RuntimeError('service_not_found', 'Codex Computer Use is not installed; install it from the desktop app');
  }

  const socketDirectory = join(home, 'Library', 'Group Containers', SKY_GROUP_CONTAINER, 'IPC');
  if (!(await fs.directory(socketDirectory))) {
    throw new RuntimeError('ipc_missing', `Computer Use IPC directory is missing at ${socketDirectory}`);
  }

  const browser = await resolveBrowser(fs, appPath, nodeModuleDirectory);
  return {
    nodeReplPath, nodePath, nodeModuleDirectory, codexPath, serviceAppPath, socketDirectory, skySkillPath, browser,
    cwd: deps.cwd ?? process.cwd(),
    codexHome: join(home, '.codex'),
  };
}

/** Browser support is optional on older desktop builds; never use an unrelated cached plugin. */
async function resolveBrowser(fs: RuntimeFs, appPath: string, modules: string): Promise<BrowserRuntime | undefined> {
  const root = join(appPath, 'Contents', 'Resources', 'plugins', 'openai-bundled', 'plugins', 'browser');
  const service = join(modules, '@oai', 'browser-desktop');
  const [hasPlugin, hasService] = await Promise.all([fs.directory(root), fs.directory(service)]);
  if (!hasPlugin && !hasService) return undefined;
  const skillPath = join(root, 'skills', 'control-in-app-browser', 'SKILL.md');
  const clientPath = join(root, 'scripts', 'browser-client.mjs');
  const [skill, client, manifest] = await Promise.all([
    fs.readText(skillPath), fs.readText(clientPath), fs.readText(join(root, '.codex-plugin', 'plugin.json')),
  ]);
  let version: unknown;
  try { version = JSON.parse(manifest ?? '{}').version; } catch { /* Report the incomplete installation below. */ }
  if (!hasPlugin || !hasService || !skill?.trim() || !client?.trim() || typeof version !== 'string' || !version.trim()) {
    throw new RuntimeError('browser_incomplete', `The official browser runtime or documentation is incomplete at ${root}; update the desktop app`);
  }
  return { skillPath, clientPath, version };
}

const MINIMAL_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

function minimalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  return result;
}

export type LaunchSpec = { command: string; args: string[]; cwd: string; env: Record<string, string> };

/**
 * The verified native-pipe launch recipe.
 *
 * `:danger-full-access` is what was verified to work, and no upgrade path to it
 * from a narrower profile is claimed: the narrower profiles were not measured
 * for `node_repl`. Every launch is therefore unrestricted, and only the user's
 * `/cua on` starts one.
 *
 * The sandbox wraps the signed `node_repl`, which reaches Sky over the official
 * IPC socket. It copies in no desktop relay, auth shim, or approval bypass.
 */
export function launchSpec(runtime: Runtime, env: NodeJS.ProcessEnv = process.env): LaunchSpec {
  return {
    command: runtime.codexPath,
    args: [
      'sandbox',
      '-P',
      ':danger-full-access',
      '--include-managed-config',
      '--allow-unix-socket',
      runtime.socketDirectory,
      runtime.nodeReplPath,
    ],
    cwd: runtime.cwd,
    env: {
      ...minimalEnv(env),
      CODEX_HOME: runtime.codexHome ?? join(homedir(), '.codex'),
      // Pin the service bundle that was actually verified. @oai/sky otherwise
      // probes CODEX_HOME and then a hardcoded bundle identifier we never checked.
      SKY_CUA_SERVICE_PATH: runtime.serviceAppPath,
      // node_repl freezes its untrusted-env snapshot; variables must be named to
      // survive. Only the explicit native bootstrap variables are allowed.
      NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: runtime.browser ? 'SKY_CUA_SERVICE_PATH,CUA_REPL_BROWSER_ENV' : 'SKY_CUA_SERVICE_PATH',
      NODE_REPL_NODE_PATH: runtime.nodePath,
      NODE_REPL_NODE_MODULE_DIRS: runtime.nodeModuleDirectory,
      // The signed module directory is the only trusted code root.
      NODE_REPL_TRUSTED_CODE_PATHS: runtime.nodeModuleDirectory,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: SKY_SERVICE_MODULE,
        ...(runtime.browser ? { browser: BROWSER_SERVICE_MODULE } : {}),
      }),
      ...(runtime.browser ? {
        BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
        BROWSER_USE_CODEX_APP_VERSION: runtime.browser.version,
        CUA_REPL_BROWSER_ENV: 'codex-app',
      } : {}),
      // The official use-case instruction the desktop app ships for this target.
      NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: COMPUTER_USE_INSTRUCTIONS,
      NODE_REPL_TRUSTED_RPC_ENABLED: '1',
      NODE_REPL_DISABLE_ANALYTICS: '1',
    },
  };
}
