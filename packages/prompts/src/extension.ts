/**
 * `withPrompts()` — `SessionExtension` factory.
 *
 * Constructs a {@link PromptsHarness} per-session at session install
 * time, wired to the session's substrate. Adopters pass renderers for
 * framework-specific content (e.g., `reactPromptRenderer` from
 * `@agentick/prompts-react`); `string` and `MessageEntry[]`
 * content shapes work natively in core without any renderer.
 *
 * Per ADR 42 §"slot trichotomy" the slot accepts three shapes:
 *
 *   1. `readonly PromptsRegisterInput[]` — array shorthand. Same as
 *      `{ initial: [...] }`.
 *   2. `Prompts` (= `PromptsHarnessProtocol`) — instance shorthand.
 *      The extension uses the adopter-supplied harness as-is across
 *      every session; adopter owns the lifecycle.
 *   3. {@link WithPromptsOptions} — config object: `initial` /
 *      `loaders` / `renderers` (built-in path) OR `use` (adopter-
 *      supplied instance).
 *
 * For single-framework adopters, prefer the framework binding's
 * convenience extension (e.g., `withReactPrompts`) which pre-bakes
 * the renderer.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md
 */

import {
  isPromptsInstance,
  type Prompts,
  type PromptsRegisterInput,
  type SessionExtension,
  type SessionInstaller,
} from "@agentick/spec";

import { PromptsHarness } from "./harness.js";
import type { PromptLoader } from "./loaders.js";
import { wirePromptProjection } from "./projection.js";
import type { PromptRenderer } from "./renderer.js";

export interface WithPromptsOptions {
  /**
   * Initial prompts seeded at session construction. Each entry is a
   * full `PromptDeclaration` wrapped in the register input. Useful for
   * shipping bundled prompts or restore-from-snapshot at startup.
   */
  readonly initial?: readonly PromptsRegisterInput[];
  /**
   * Prompt loaders evaluated at install time. All loaders run
   * concurrently; their outputs concatenate (input order) and are
   * registered after `initial`. Use `@agentick/prompts/loaders`
   * for `fromArray` / `fromModule` / `fromStaticUrl`; framework
   * bindings ship their own (`@agentick/prompts-react/loaders`).
   */
  readonly loaders?: readonly PromptLoader[];
  /**
   * Renderers handling non-native content shapes. First-match-wins on
   * `renderer.handles(content)`. Framework bindings ship their own.
   */
  readonly renderers?: readonly PromptRenderer[];
  /**
   * Adopter-supplied `Prompts` instance. The extension uses this
   * as-is across every session — NO per-session construction, NO
   * close on session teardown. Use this when one source-of-truth
   * should back many sessions (a shared on-disk DB, a remote
   * registry, a cluster-wide replica).
   *
   * Mutually exclusive with `initial` / `loaders` / `renderers` — if
   * you bring your own instance, you also own seeding, reload, and
   * renderer configuration. The extension still publishes the
   * instance under the session's `prompts` namespace so tools,
   * getters, and bridges resolve to it.
   */
  readonly use?: Prompts;
  /**
   * Project each registered prompt as a read-only `prompt://<name>` resource on
   * the session's resources harness. Defaults to `true` — the prompt catalog
   * becomes browsable through the standard resources surface (and the MCP
   * projection) with zero bespoke wire work. The projection is LIVE (prompts
   * registered / removed after install project / unregister via the harness
   * change-subscription). Content is served HONESTLY: a static string `template`
   * is served as `text/markdown`; a function `render` (or a non-string
   * `template`) yields a `{ name, description, arguments }` declaration document
   * (`application/json`) — a function is never serialized, a render result never
   * faked. Set `false` to keep prompts off the resources surface.
   */
  readonly exposeAsResources?: boolean;
}

/**
 * Top-level slot shape accepted by `withPrompts`. Per ADR 42 — array,
 * instance, OR config object. See file-level comment for semantics.
 */
export type WithPromptsSlot = readonly PromptsRegisterInput[] | Prompts | WithPromptsOptions;

// TODO(tools-sweep / three-audiences-plan §D): a `src/tools.ts` shipping
// model-facing `prompt_*` tools (e.g. `prompt_list` / `prompt_get`) would
// slot in here behind a `registerModelTools` option, same shape as
// `resources/src/tools.ts` + `skills/src/tools.ts`. DEFERRED: prompts are
// USER-controlled (invoked by the human, not model-discovered), so a
// model-facing surface needs its audience story told first — the
// convention does not launch it as filler. When added: reach the harness
// through a `ctx.prompts` slot (NOT `ctx.session`) + augment
// `ToolHandlerCtxExtensions`.
export function withPrompts(slot: WithPromptsSlot = {}): SessionExtension {
  const options = resolveSlot(slot);
  return {
    name: "@agentick/prompts",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // ──────── Form B (instance) — adopter owns lifecycle ────────
      if (options.use !== undefined) {
        installer.registerNamespace("prompts", options.use);
        // `prompt://<name>` projection (default-on). Reads the live instance;
        // our resource registrations + subscription unwind on close WITHOUT
        // closing the adopter-owned harness.
        if (options.exposeAsResources !== false) {
          wirePromptProjection(installer, options.use);
        }
        // Adopter brought the instance — adopter closes it.
        return;
      }

      // ──────── Forms A / C (built-in path) ────────
      // Read the session's timeline harness if available — `invoke()`
      // uses it to queue messages into the durable timeline. When
      // absent (e.g., test setup), `invoke()` skips queueing.
      const timeline = (installer.getNamespace?.("timeline") ?? undefined) as
        | import("@agentick/spec").TimelineHarnessProtocol
        | undefined;

      const harness = new PromptsHarness(
        `${installer.hostId}:prompts`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          ...(options.renderers ? { renderers: options.renderers } : {}),
          ...(timeline ? { timeline } : {}),
        },
      );
      await harness.ready;

      // Retain loaders for post-startup reload() + lookup-on-miss in
      // invoke() / get().
      if (options.loaders && options.loaders.length > 0) {
        harness.setLoaders(options.loaders);
      }

      if (options.initial && options.initial.length > 0) {
        for (const decl of options.initial) {
          await harness.register(decl);
        }
      }

      if (options.loaders && options.loaders.length > 0) {
        const batches = await Promise.all(options.loaders.map((l) => l.load()));
        for (const batch of batches) {
          for (const decl of batch) {
            await harness.register(decl);
          }
        }
      }

      // `prompt://<name>` projection (default-on) — the prompt catalog becomes
      // addressable through the standard resources surface. LIVE via the harness
      // change-subscription; content served honestly (string template as text,
      // else a declaration document — never a serialized function).
      if (options.exposeAsResources !== false) {
        wirePromptProjection(installer, harness);
      }

      installer.registerNamespace("prompts", harness);
      installer.onClose(() => harness.close());
    },
  };
}

/**
 * Normalize the trichotomic slot into a {@link WithPromptsOptions}
 * shape the install path consumes uniformly. Exported for tests +
 * adopters who want to inspect the resolved shape; the slot itself
 * is the public surface.
 */
export function resolveSlot(slot: WithPromptsSlot): WithPromptsOptions {
  if (Array.isArray(slot)) {
    return { initial: slot };
  }
  if (isPromptsInstance(slot)) {
    return { use: slot };
  }
  const cfg = slot as WithPromptsOptions;
  if (
    cfg.use !== undefined &&
    (cfg.initial !== undefined || cfg.loaders !== undefined || cfg.renderers !== undefined)
  ) {
    throw new Error(
      "withPrompts: `use:` is mutually exclusive with `initial` / `loaders` / `renderers` — " +
        "adopter-supplied instances own their seeding, reload, and renderer configuration.",
    );
  }
  return cfg;
}
