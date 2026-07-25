/**
 * `withTasks()` — `SessionExtension` factory.
 *
 * The AppHarness constructs the per-session {@link TasksHarness} BEFORE
 * session-extension installs run (single-construction-site, #159) and
 * exposes it on `installer.tasks`. `withTasks()` therefore does NOT
 * construct a harness; constructing one against the same substrate
 * would collide on the inbox address (`tasks:${sessionId}:tasks`) and
 * cause `bridges.tasks` / `ctx.tasks` / `session.tasks` to resolve to
 * different instances.
 *
 * What `withTasks()` still does is auto-register the four
 * model-facing `task_*` tools (list / get / cancel / await)
 * so Pattern B (`taskSupport: "required"`) tools are usable
 * out-of-the-box. The handlers reach the host's `TasksHarness` via
 * `ctx.tasks` — the same instance the AppHarness already wired into
 * the ToolExecutor and the session bridges.
 *
 * Lifecycle (`close`, `ready`) is owned by the AppHarness, NOT by
 * this extension. Don't register `onClose(() => harness.close())`
 * here — the AppHarness's `close()` path handles it.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec";
import { EXTENSION_NAME } from "./extension-name.js";
import { buildSessionTasksTools } from "./tools.js";

export interface WithTasksOptions {
  /**
   * Skip auto-registering the model-facing `task_*` tools.
   * Defaults to `false` — by default `withTasks()` registers four
   * tools that let the model list / get / cancel / await framework
   * background tasks (required for Pattern B `taskSupport: "required"`
   * tools to be usable).
   *
   * Set to `true` if the adopter wants the harness substrate without
   * the model surface — e.g., headless servers driving tasks
   * exclusively from adopter code with no LLM in the loop.
   */
  readonly registerModelTools?: boolean;
}

export function withTasks(options: WithTasksOptions = {}): SessionExtension {
  const registerModelTools = options.registerModelTools !== false;
  return {
    name: EXTENSION_NAME,
    target: "session",
    install: (installer: SessionInstaller): void => {
      if (!registerModelTools) return;

      // Auto-register the four model-facing `task_*` tools.
      // Handlers read `ctx.tasks` at call time — the AppHarness has
      // already wired its single per-session `TasksHarness` into the
      // ToolExecutor's `ctx.tasks` slot AND into `bridges.tasks`,
      // so registering handlers here does not require touching the
      // harness instance directly.
      //
      // The list handler ALSO peeks at `bridges.mcp` at call time (per
      // #175) so the model can enumerate remote MCP tasks alongside
      // local ones. `getNamespace` here closes over the per-session
      // bridge map — the lookup happens at tool-call time, not now,
      // so install order between `withTasks` and `withMCP` doesn't
      // matter.
      const getNamespace = (name: string): unknown =>
        installer.getNamespace ? installer.getNamespace<unknown>(name) : undefined;
      const bundle = buildSessionTasksTools(installer.sessionId, getNamespace);
      for (const { handlerRef, handler } of bundle.handlers) {
        installer.registerToolHandler(handlerRef, handler);
      }
      for (const registration of bundle.registrations) {
        installer.registerExtensionTool(registration);
      }
    },
  };
}
