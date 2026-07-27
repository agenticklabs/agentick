/**
 * `@agentick/client` — the batteries-included agentick client (the default).
 *
 * Re-exports everything from `@agentick/client-core` (the lean,
 * harness-agnostic core) AND side-effect-imports every built-in `/client`
 * subpath, so their session sub-handles self-assemble on the client
 * `SessionHandle` (ADR 87) with no per-harness imports:
 *
 * ```ts
 * import { createClient } from "@agentick/client";
 * const client = await createClient({ transport });
 * const session = client.session(id);
 * session.tasks.list();                      // @agentick/tasks/client
 * await session.knobs.set("temperature", 1); // @agentick/knobs/client
 * session.elicitations.subscribe(() => {     // @agentick/elicitation/client
 *   for (const e of session.elicitations.list()) void e.accept({});
 * });
 * session.timeline.list();                    // @agentick/timeline/client
 * ```
 *
 * This is the client twin of how the public `agentick` metapackage bundles the
 * server built-ins — `@agentick/client` is the default (everything works), while
 * `@agentick/client-core` is the opt-in lean core for adopters who want
 * minimal imports and add only the `/client` subpaths they need. At the v2 cut
 * these become `@agentick/client` (this bundle) + `@agentick/client-core`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md (bundled, not privileged)
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 * @verifiedBy packages/client/src/__tests__/bundle.spec.ts
 */

// Side-effect: each import types its slot (declare module) AND registers its
// runtime factory. Order is irrelevant — the registry is keyed by name.
import "@agentick/tasks/client";
import "@agentick/knobs/client";
import "@agentick/elicitation/client";
import "@agentick/tool-executor/client";
import "@agentick/timeline/client";
import "@agentick/gates/client";
// Three-audiences-plan §G — the client parity handles (skills, prompts,
// resources, state). Each types its slot + registers its runtime factory.
import "@agentick/skills/client";
import "@agentick/prompts/client";
import "@agentick/resources/client";
import "@agentick/state/client";

// Re-export the full client-core surface (createClient, handles, channelView,
// the sub-handle registry, protocol type re-exports, …).
export * from "@agentick/client-core";
