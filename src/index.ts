import { randomUUID } from 'node:crypto';
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { NativeClient, RequestFailure, type Backend, type Description, type Identity } from './client.ts';
import { resolveRuntime } from './runtime.ts';

const ENTRY = 'pi-cua:enabled';
const nativeName = (name: string) => `cua_${name}`;
const RESULT = Type.Unsafe({ type: 'object', properties: { content: { type: 'array' } }, required: ['content'] });

export interface Dependencies {
  createBackend?: (cwd: string) => Promise<Backend>;
}

/** Pi owns opt-in and session lifetime; the official runtime owns JavaScript and Computer Use behavior. */
export function createCuaExtension(deps: Dependencies = {}) {
  return (pi: ExtensionAPI): void => {
    let enabled = false;
    let backend: Backend | undefined;
    let opening: Promise<void> | undefined;
    let closing: Promise<void> = Promise.resolve();
    let failure: string | undefined;
    let scope = new AbortController();
    let description: Description | undefined;
    let sessionId: string | undefined;
    let turn = { id: randomUUID(), startedAt: Date.now() };
    const registered = new Set<string>();
    const approvalNotices = new Set<string>();

    function saved(ctx: ExtensionContext): boolean {
      for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
        if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
        const data = entry.data as { version?: number; enabled?: boolean } | undefined;
        return data?.version === 1 && data.enabled === true;
      }
      return false;
    }
    function save(ctx: ExtensionContext, value: boolean): void {
      if (saved(ctx) !== value) pi.appendEntry(ENTRY, { version: 1, enabled: value });
    }

    function withdraw(): void {
      for (const name of registered) pi.registerTool({
        name, label: name, description: 'Computer Use is disabled.',
        parameters: Type.Object({}), exposure: 'hidden',
        async execute() { throw new Error('Computer Use is disabled. Run /cua on.'); },
      });
      pi.setActiveTools(pi.getActiveTools().filter(name => !registered.has(name)));
    }

    function publish(info: Description): void {
      withdraw();
      for (const tool of info.tools) {
        const name = nativeName(tool.name);
        registered.add(name);
        pi.registerTool({
          name, label: tool.title ?? tool.annotations?.title ?? tool.name,
          description: tool.description ?? '',
          // No schema rewriting, method whitelist, or locally authored descriptions.
          parameters: Type.Unsafe(tool.inputSchema),
          outputSchema: RESULT,
          annotations: tool.annotations,
          exposure: 'direct', executionMode: 'sequential',
          renderCall: (args, theme) => {
            const title = (args as { title?: unknown }).title;
            return new Text(theme.fg('toolTitle', tool.title ?? tool.name) +
              (typeof title === 'string' ? ` ${theme.fg('muted', title)}` : ''), 0, 0);
          },
          async execute(callId, params, signal, _onUpdate, ctx) {
            const current = backend;
            if (!enabled || !current?.connected) {
              return errorResult(new RequestFailure('Computer Use is not connected. Run /cua on. A new process starts a fresh REPL.', 'not_sent'));
            }
            const combined = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
            const identity: Identity = {
              sessionId: ctx.sessionManager.getSessionId(), turnId: turn.id, startedAt: turn.startedAt,
              model: ctx.model?.id ?? 'unknown', callId, reasoningEffort: ctx.thinkingLevel,
            };
            try {
              const result = await current.call(tool.name, params as Record<string, unknown>, identity,
                (request, approvalSignal) => approve(request, approvalSignal, ctx, approvalNotices), combined);
              return present(result);
            } catch (error) {
              // Do not silently reconnect/replay a script, or claim its state survived.
              return errorResult(error);
            }
          },
        });
      }
      pi.setActiveTools([...pi.getActiveTools().filter(name => !registered.has(name)), ...info.tools.map(tool => nativeName(tool.name))]);
    }

    async function closeOwned(owned?: Backend): Promise<void> {
      try { await owned?.close(); }
      catch (error) { failure = String(error); throw error; }
    }

    async function stop(): Promise<void> {
      enabled = false;
      scope.abort(new Error('Computer Use disabled or session replaced.'));
      scope = new AbortController();
      description = undefined;
      withdraw();
      const owned = backend;
      backend = undefined;
      const starting = opening;
      opening = undefined;
      closing = closing.then(async () => {
        // open() receives the aborted scope. Closing an already published client
        // reaches its child even while protocol initialization is in flight.
        await Promise.allSettled([closeOwned(owned), starting]);
        if (failure) throw new Error(failure);
      });
      return closing;
    }

    async function start(cwd: string): Promise<void> {
      if (enabled && backend?.connected) return;
      if (opening) return opening;
      if (failure) throw new Error(failure);
      const signal = scope.signal;
      const attempt = (async () => {
        await closing;
        signal.throwIfAborted();
        // A dead protocol may still own a child. Reap it before replacement.
        await closeOwned(backend);
        backend = undefined;
        if (failure) throw new Error(failure);
        const owned = await (deps.createBackend ?? (async cwd => new NativeClient(await resolveRuntime({ cwd }))))(cwd);
        try {
          signal.throwIfAborted();
          backend = owned;
          const info = await owned.open(signal);
          signal.throwIfAborted();
          description = info;
          enabled = true;
          publish(info);
        } catch (error) {
          try { await closeOwned(owned); }
          catch (cleanup) { throw new AggregateError([error, cleanup], `Startup failed: ${String(error)}; cleanup failed: ${failure}`); }
          if (backend === owned) backend = undefined;
          throw error;
        }
      })();
      opening = attempt;
      try { await attempt; }
      finally { if (opening === attempt) opening = undefined; }
    }

    pi.registerCommand('cua', {
      description: 'Enable, disable, or report Computer Use: /cua [on|off|status]',
      async handler(args, ctx) {
        try {
          switch (args.trim().toLowerCase()) {
            case 'on':
              await start(ctx.cwd);
              try { save(ctx, true); }
              catch (error) { await stop(); throw error; }
              ctx.ui.notify('Computer Use enabled.', 'info');
              break;
            case 'off': {
              // Even a persistence failure must not leave the runtime running.
              try { save(ctx, false); }
              finally { await stop(); }
              ctx.ui.notify('Computer Use disabled.', 'info');
              break;
            }
            case '': case 'status':
              ctx.ui.notify(failure ? `Computer Use cleanup failed: ${failure}` :
                opening ? 'Computer Use is connecting.' : enabled && backend?.connected ? 'Computer Use is running.' :
                enabled ? 'Computer Use is off. Use /cua on to start.' : 'Computer Use disabled.', failure ? 'warning' : 'info');
              break;
            default: ctx.ui.notify('Usage: /cua on | off | status', 'warning');
          }
        } catch (error) { ctx.ui.notify(`Computer Use: ${String(error)}`, 'warning'); }
      },
    });

    pi.on('before_agent_start', event => {
      if (!enabled || !backend?.connected) return;
      event.systemPromptOptions.promptGuidelines.push(
        'The user enabled Computer Use for this session. Native node_repl tools are exposed with the cua_ prefix (js → cua_js, js_reset → cua_js_reset).',
        'For the native macOS API, import @oai/sky inside cua_js. JavaScript variables persist between calls and turns until reset, disable, session replacement, or process exit.',
        ...(description?.skySkillPath ? [
          `Computer Use skill: control local Mac apps through the official @oai/sky API. Before performing Computer Use, read the entire official skill at ${JSON.stringify(description.skySkillPath)} with the read tool. It contains the API, initialization, action/observation workflow, screenshot output and rich-text paste instructions. Follow that document rather than guessing API calls. Its node_repl/js references mean cua_js in this host.`,
        ] : []),
        ...(description?.browser ? [
          `Browser skill (Chrome via the ChatGPT extension): before browser work, read the entire official skill at ${JSON.stringify(description.browser.skillPath)}. Its plugin root supplies the absolute browser-client entry ${JSON.stringify(description.browser.clientPath)}. Follow the skill and emit/read the selected browser's complete documentation before using it.`,
          'Browser host mapping: use cua_js for the skill\'s node_repl/js tool. This host enables only the Chrome extension backend, not the in-app browser. Do not infer in-app-browser availability from the Browser skill being present. The existing Sky API remains available for native desktop tasks. When using Pi CodeMode for the initial browser documentation call, use its first-line // @options: {"max_output_tokens": 20000} pragma instead of the Codex exec pragma, and forward the complete result.',
        ] : []),
        ...(description?.instructions ? [description.instructions] : []),
      );
    });
    pi.on('agent_start', () => { turn = { id: randomUUID(), startedAt: Date.now() }; });
    pi.on('agent_end', async (_event, ctx) => {
      try { await backend?.endTurn(); }
      catch (error) { ctx.ui.notify(`Computer Use turn end failed: ${String(error)}`, 'warning'); }
    });
    pi.on('session_start', async (_event, ctx) => {
      try {
        await stop();
        sessionId = ctx.sessionManager.getSessionId();
        if (saved(ctx)) await start(ctx.cwd);
      } catch (error) { ctx.ui.notify(`Computer Use: ${String(error)}`, 'warning'); }
    });
    pi.on('session_tree', async (_event, ctx) => {
      try {
        if (sessionId !== ctx.sessionManager.getSessionId() || !saved(ctx)) await stop();
        sessionId = ctx.sessionManager.getSessionId();
        if (saved(ctx)) await start(ctx.cwd);
      } catch (error) { ctx.ui.notify(`Computer Use: ${String(error)}`, 'warning'); }
    });
    pi.on('session_shutdown', async (_event, ctx) => {
      try { await stop(); }
      catch (error) { ctx.ui.notify(`Computer Use cleanup failed: ${String(error)}`, 'warning'); }
    });
  };
}

/** Preserve the full native MCP result as structured data; show native text/images to the model. */
export function present(result: CallToolResult): AgentToolResult<undefined> {
  return {
    content: result.content.map(block => block.type === 'text' ? { type: 'text' as const, text: block.text } :
      block.type === 'image' ? { type: 'image' as const, data: block.data, mimeType: block.mimeType } :
      { type: 'text' as const, text: JSON.stringify(block) }),
    details: undefined,
    structuredContent: result as AgentToolResult<undefined>['structuredContent'],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

function errorResult(error: unknown): AgentToolResult<undefined> {
  return present({ content: [{ type: 'text', text: String(error) }], isError: true,
    ...(error instanceof RequestFailure ? { structuredContent: { outcome: error.outcome } } : {}),
  });
}

async function approve(request: Parameters<import('./client.ts').Approve>[0], signal: AbortSignal, ctx: ExtensionToolContext, notices: Set<string>): Promise<ElicitResult> {
  if (signal.aborted) return { action: 'decline' };
  if (request.mode === 'url' || Object.keys(request.requestedSchema?.properties ?? {}).length > 0) {
    ctx.ui.notify(`A request was declined because Pi can't display it yet. ${request.message}`, 'warning');
    return { action: 'decline' };
  }
  // Existing /cua on authorization includes the runtime's consent-only app access.
  const sessionId = ctx.sessionManager.getSessionId();
  if (!notices.has(sessionId)) {
    ctx.ui.notify('Computer Use app access automatically approved for this session.', 'info');
    notices.add(sessionId);
  }
  return { action: 'accept' };
}

export default createCuaExtension();
