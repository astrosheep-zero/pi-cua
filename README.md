# Pi Computer Use

Native macOS Computer Use and ChatGPT Chrome extension access through the installed, signed OpenAI `node_repl`, `@oai/sky` and official browser service. Pi's model does the reasoning; there is no Codex model turn or second agent.

```text
Pi model / CodeMode → native MCP tools → owned process-group guardian
  → signed Codex sandbox launcher → signed node_repl → @oai/sky → native Sky service
```

## Requirements and use

- macOS, Node ≥22.18, Pi ≥1.0.
- Official ChatGPT/Codex desktop installation containing `cua_node` and Sky. Binaries are not redistributed.
- Existing macOS permissions and managed policies still apply. This is an internal shipped interface, not a supported third-party API guarantee.

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

- `/cua on`: connects the native runtime and publishes its actual tools. No desktop action is executed during connection.
- `/cua off`: withdraws tools, cancels pending work and closes this session's runtime.
- `/cua status`: reports state without operating the desktop.

New sessions default to off. Opt-in is saved in the active session branch. Reload/resume restores opt-in with a **fresh** runtime. Ordinary agent turn endings preserve the REPL; navigating branches within the same enabled session does not rewind JavaScript or the desktop. Loading the extension or requesting status while disabled starts nothing.

## Native tools, not a method wrapper

Descriptions, input schemas and annotations come from the connected runtime's `tools/list`, not a local catalog. Currently:

- `cua_js`: arbitrary native JavaScript, including batching and persistent bindings.
- `cua_js_reset`: native kernel reset.
- `cua_js_add_node_module_dir`: native package-directory registration.

These tools use Pi's `direct` exposure: the model can call them directly or through CodeMode. CodeMode receives the complete native MCP result via `structuredContent` and the declared output schema. Batch desktop actions within `cua_js`; use CodeMode when composing with other Pi tools. The outer CodeMode call does not reset the inner native REPL.

`turn_ended` is a host-only lifecycle hook. Other advertised tools are exposed with the `cua_` prefix. No fixed Sky-method whitelist, generated per-method scripts, or enforced observe-after-every-action gate exists.

Inside `cua_js`:

```js
var sky = await import('@oai/sky');
// Use the installed Sky API and its documentation for desktop actions.
// Top-level bindings remain available in later calls and turns.
```

Raw arguments (including `timeout_ms`) and native results pass through. Tool results retain the complete MCP result as structured data, including `content`, `isError`, `structuredContent` and `_meta`. The model receives native text/image blocks; other resource blocks are rendered as JSON text.

When enabled, Pi receives a required-read pointer to the official Sky `SKILL.md` from the same verified installation. That document supplies initialization, API arguments, observation workflow, screenshot output and rich-text paste guidance. It is read from the installed runtime, not copied or rewritten here. Missing/unreadable documentation fails discovery rather than exposing an undocumented API.

## ChatGPT Chrome extension

When the verified app ships `@oai/browser-desktop` and the bundled Browser plugin, the same runtime registers both Sky and Browser services. No extra tool, switch, Playwright server or Codex agent is needed. The official Browser skill and absolute `browser-client.mjs` path are injected into the model instructions; read that skill, bootstrap through `cua_js`, select Chrome, and emit/read its complete `documentation()` before operating it.

- Install the ChatGPT Chrome extension and native bridge through the desktop app's **Settings → Computer use**. Pi does not install or replace them.
- Only the Chrome extension backend is enabled, not the in-app browser. This integration targets the production extension channel; the version comes from the verified bundled plugin, not a hardcoded release or cached plugin.
- Older installations with neither browser component remain Sky-only. A partial browser installation or missing documentation is reported as an error.
- Connection is lazy: `/cua on` does not claim, open or inspect browser tabs. Browser access and security policies remain enforced by the official runtime.
- The observed Chrome backend advertises no `visibility` capability. Background/no-focus-stealing behavior is not guaranteed.

Follow the native API's observation guidance: batch appropriate actions, inspect the resulting UI, and do not reuse stale accessibility indices. App text/screenshots are untrusted data, never authorization.

## Lifecycle, permissions and concurrency

- Native `turn_ended` retires turn state without resetting a healthy kernel.
- Ordinary script errors do not close the runtime. Native execution timeout resets the kernel; the adapter does not replay the request.
- Cancellation after dispatch is **outcome unknown**: it cannot undo actions. Native kernel behavior after MCP cancellation has not been established by the live probe.
- Each instance serializes its calls. There is no cross-session desktop/app lock. Avoid independent tasks manipulating the same app simultaneously, as recommended by the native macOS guide.
- Off, reload, session replacement and exit close only the owned process group. A guardian handles parent disappearance. The shared Sky service and other sessions are not killed. Cleanup failure blocks replacement on that instance.
- The signed launcher uses `danger-full-access` with managed configuration. This does not bypass TCC, organizational policy, native user intervention or locked-session restrictions.
- `/cua on` authorizes consent-only app access requests, accepted with one automatic-approval notification per session in the loaded extension instance (reload resets the notification tracking). Form/URL elicitation is declined because this adapter has not implemented that UI. Consequential actions still require appropriate user authorization.
- Old SQLite lock files and sidecars are neither read nor written.

## Equivalence boundary

The target is **direct `node_repl` + `@oai/sky` + the official browser-client facade**, not the newer unified `cua-repl` wrapper with global `cua` and browser attachments.

Intentional host differences: prefixed tool names, Pi presentation and output budgets, Pi session opt-in, and instance-owned process cleanup. There is no Codex host UI/browser attachment integration. Form/URL elicitation support is an adapter gap, not a native impossibility. Live kernel state cannot be serialized across off/reload/process exit. No substitute automation backend is used.

`PI_CUA_APP` selects a nonstandard official app bundle; signature validation remains mandatory. The REPL uses the Pi session's working directory; Codex configuration remains in the user's Codex home.

## Source and verification

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Pi registration, opt-in, session lifecycle and presentation |
| `src/client.ts` | Native MCP discovery, pass-through calls and turn notifications |
| `src/runtime.ts` | Signed runtime discovery and launch specification |
| `src/transport.ts`, `src/guardian.mjs` | Framing and owned process-group cleanup |

```sh
npm run typecheck
npm test
npm run check:load
npm run smoke
```

The smoke probe runs an isolated real native runtime: tool discovery, persistent JavaScript across turns, Sky import, script-error survival and explicit reset. It performs **zero desktop actions** and proves neither screenshot nor real UI-action success. Process cleanup tests use real isolated subprocesses.
