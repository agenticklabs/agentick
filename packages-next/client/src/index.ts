/**
 * `@agentick/client-next` — the batteries-included agentick client (the default).
 *
 * Re-exports everything from `@agentick/client-core-next` (the lean,
 * harness-agnostic core) AND side-effect-imports every built-in `/client`
 * subpath, so their session sub-handles self-assemble on the client
 * `SessionHandle` (ADR 87) with no per-harness imports:
 *
 * ```ts
 * import { createClient } from "@agentick/client-next";
 * const client = await createClient({ transport });
 * const session = client.session(id);
 * session.tasks.get();                       // @agentick/tasks-next/client
 * await session.knobs.set("temperature", 1); // @agentick/knobs-next/client
 * for await (const e of session.elicitations) await e.accept({}); // elicitation (a property)
 * ```
 *
 * This is the client twin of how the public `agentick` metapackage bundles the
 * server built-ins — `client-next` is the default (everything works), while
 * `@agentick/client-core-next` is the opt-in lean core for adopters who want
 * minimal imports and add only the `/client` subpaths they need. At the v2 cut
 * these become `@agentick/client` (this bundle) + `@agentick/client-core`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md (bundled, not privileged)
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 * @verifiedBy packages-next/client/src/__tests__/bundle.spec.ts
 */

// Side-effect: each import types its slot (declare module) AND registers its
// runtime factory. Order is irrelevant — the registry is keyed by name.
import "@agentick/tasks-next/client";
import "@agentick/knobs-next/client";
import "@agentick/elicitation-next/client";
import "@agentick/tool-executor-next/client";

// Re-export the full client-core surface (createClient, handles, channelView,
// the sub-handle registry, protocol type re-exports, …).
export * from "@agentick/client-core-next";
