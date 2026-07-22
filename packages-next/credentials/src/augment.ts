/**
 * Module augmentation — adds `credentials` to the spec's empty
 * `HookBridges` seed per ADR 27 (modular built-ins).
 *
 * Loaded as a side-effect when anything imports from
 * `@agentick/credentials-next` (the barrel re-exports this file).
 *
 * **Optional slot.** Unlike elicitation / tasks, the credentials
 * harness is NOT installed for every session — it's wired by the
 * adopter via `withCredentials({ store })` at app or gateway level.
 * Sessions that don't have a credentials install see `undefined` on
 * the slot. Consumers (`withMCP`, future adopter code) MUST check
 * for presence; there is no no-op fallback because the slot
 * intentionally signals "no credential storage is wired."
 *
 * **Empty wire surface (data-layer Playbook P6 / E7).** Credentials is
 * the valid EMPTY-wire-surface store: it projects NOTHING to the client.
 * Where knobs and tasks project their collection to a client mirror
 * (`CollectionProjection` + a wire channel), credentials deliberately has
 * no client projection at all — the substrate is server-resident and the
 * material never crosses the wire. This is the concrete proof that "a
 * store-backed harness projects to the client" is CONDITIONAL: a
 * server-only store's correct wire surface is empty. Client-driven
 * credential lifecycle (re-auth, disconnect) travels as action VERBS over
 * the wire-extensions framework (#280) and resolves server-side; the
 * response carries status, never tokens.
 *
 * **NOT `SnapshotCapable`.** The session snapshot/restore machinery
 * (`compiler-react` iterates `HookBridges` via feature detection
 * for `snapshot()` / `restore()`) intentionally skips this slot —
 * credentials must never enter a serialized session snapshot. Tokens
 * could leak via persisted disk snapshots, debug-export tooling,
 * journaled events, or shared error reports.
 * TODO(#281): formalize the snapshot-skip via a `NonSnapshottable`
 * type-level marker so the rule is enforced rather than convention.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md — ADR 27
 */

import type { CredentialsHarnessProtocol } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Credentials substrate — present only when an app- or gateway-
     * level `withCredentials({ store })` is installed. `undefined`
     * otherwise.
     *
     * Per the `credentials-never-cross-wire` invariant, this slot is
     * server-resident — never serialized into snapshots, never
     * projected onto a client-side `bridges` mirror.
     */
    readonly credentials?: CredentialsHarnessProtocol;
  }
}
