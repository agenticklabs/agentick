/**
 * `withResources()` — `SessionExtension` factory.
 *
 * The AppHarness constructs the per-session {@link ResourcesHarness}
 * BEFORE session-extension installs run (single-construction-site, #159)
 * and exposes it on `installer.resources` + `bridges.resources` +
 * `ctx.resource`. `withResources()` therefore does NOT construct a
 * harness; constructing one against the same substrate would collide on
 * the inbox address (`resources:${sessionId}:resources`) and cause
 * `bridges.resources` / `ctx.resource` / the MCP-surfaced registry to
 * resolve to different instances. This mirrors `withTasks()` verbatim.
 *
 * What `withResources()` DOES: auto-register the two model-facing
 * `resource_*` tools (`resource_list` / `resource_read`) so the model
 * can enumerate + read the application's resources out-of-the-box. The
 * handlers reach the host's `ResourcesHarness` via `ctx.resource` — the
 * same instance the AppHarness already wired into the ToolExecutor and
 * the session bridges. The React `<Resource>` front-end
 * (`@agentick/resources-next/react`) and `withMCP` remote-resource
 * surfacing populate that same registry independently.
 *
 * Lifecycle (`close`, `ready`) is owned by the AppHarness, NOT by this
 * extension. Don't register `onClose(() => harness.close())` here.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec-next";
import { EXTENSION_NAME } from "./extension-name.js";
import { buildResourcesTools } from "./tools.js";

export interface WithResourcesOptions {
  /**
   * Skip auto-registering the model-facing `resource_*` tools. Defaults
   * to `false` — by default `withResources()` registers `resource_list`
   * + `resource_read` so a model can discover and read the application's
   * resources with zero extra wiring.
   *
   * Set to `true` for the harness substrate without the model surface —
   * e.g. an app that exposes resources ONLY over its MCP-server
   * projection, or a headless pipeline that reads resources exclusively
   * from adopter code (`ctx.resource` / `session.resources`) with no LLM
   * in the loop.
   */
  readonly registerModelTools?: boolean;
}

// TODO(store-phase-4): thread durable `store?` + `loaders?` to the ResourcesHarness.
// The seam already exists on `ResourcesHarnessOptions` (constructor) and is exercised
// by the store-backing spec, but `withResources()` does NOT construct the harness —
// the AppHarness owns the single construction site (#159, to avoid an inbox-address
// collision). Wiring adopter loaders/store from here requires the AppHarness
// construction path (`session/src/session-bridges.ts` + `define-session.ts`) to accept
// and forward them, a cross-package SessionOptions change. Deferred until that plumbing
// lands; until then adopters inject `{ store, loaders }` directly at the harness
// constructor (or via `harness.setLoaders(...)`) and call `reload()`.

export function withResources(options: WithResourcesOptions = {}): SessionExtension {
  const registerModelTools = options.registerModelTools !== false;
  return {
    name: EXTENSION_NAME,
    target: "session",
    install: (installer: SessionInstaller): void => {
      if (!registerModelTools) return;

      // Auto-register `resource_list` / `resource_read`. Handlers read
      // `ctx.resource` at call time — the AppHarness has already wired
      // its single per-session `ResourcesHarness` into the ToolExecutor's
      // `ctx.resource` slot AND into `bridges.resources`, so registering
      // handlers here does not require touching the harness instance.
      const bundle = buildResourcesTools(installer.sessionId);
      for (const { handlerRef, handler } of bundle.handlers) {
        installer.registerToolHandler(handlerRef, handler);
      }
      for (const registration of bundle.registrations) {
        installer.registerExtensionTool(registration);
      }
    },
  };
}
