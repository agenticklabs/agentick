/**
 * `@agentick/gates/client` — the client-side projection of the gate
 * registry (ADR 87). The wire twin of the server `session.gates`.
 *
 * RPC-backed: `list()`/`get()` read a local snapshot polled from `gates/list`
 * (eager seed + re-poll after each mutation), and the verbs ride the `gates/*`
 * dynamic-lane commands. Depends on `@agentick/client-core` (the
 * `registerSessionHandleExtension` registry + the `ClientHandle`/`Enumerable`
 * contract) — NOT on the gates harness runtime. Mirrors the `/react` subpath
 * convention: a harness package MAY add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `gates/*` valid `WireMethods` rows for the
// client handle's `transport.request("gates/…", …)` — WITHOUT the server
// augmentations (zero runtime).
import "../wire-augment.js";

export { gatesHandle, type GatesClientHandle, type GatesCommandClient } from "./gates-handle.js";

// Side-effect: contribute `session.gates` to the client SessionHandle (ADR 87).
import "./register.js";
