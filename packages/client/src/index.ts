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

import {
  createClient as coreCreateClient,
  type Client,
  type CreateClientOptions,
} from "@agentick/client-core";
import { telemetry as telemetryExtension } from "@agentick/client-extensions";

// Re-export the full client-core surface EXCEPT `createClient` — this package
// wraps it (below) so a top-level config namespace can install the built-in
// extension it belongs to.
export * from "@agentick/client-core";

// ── Built-in extensions with config get a TOP-LEVEL namespace ────────────────
//
// The sub-handles above self-assemble and need no configuration. An extension
// that DOES take config (telemetry, so far) gets a named option on
// `createClient` rather than making the adopter hand-build an `extensions`
// entry — the same shape `createApp({ telemetry })` already has on the server.
//
// Wiring it here rather than in `client-core` is ADR 27 doing its job: the lean
// core must not depend on the extension package, and bundling built-ins is
// exactly what a metapackage is for.

/**
 * Batteries-included `createClient`.
 *
 * Identical to `@agentick/client-core`'s, plus: a top-level config namespace
 * for each built-in extension that takes configuration. Today that is
 * `telemetry` — the ONE object serves both consumers, so `client.runtime`'s
 * facets and the per-RPC wire spans share an adapter by construction and their
 * span trees cannot diverge.
 *
 * ```ts
 * const client = await createClient({
 *   transport,
 *   telemetry: { adapter, sample: (m) => m !== "session/snapshot" },
 * });
 * ```
 */
export async function createClient(options: CreateClientOptions): Promise<Client> {
  const { telemetry: config } = options;
  if (config === undefined) return coreCreateClient(options);
  return coreCreateClient({
    ...options,
    // Appended, so an adopter-supplied extension still wraps outside it.
    extensions: [...(options.extensions ?? []), telemetryExtension(config)],
  });
}
