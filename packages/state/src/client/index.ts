/**
 * `@agentick/state/client` — the client-side projection of the session
 * state stash (ADR 87). The wire twin of the server `session.state`.
 *
 * RPC-backed: `list()`/`get()` read a local snapshot polled from `state/list`
 * (eager seed + re-poll after each mutation), and the verbs ride the `state/*`
 * dynamic-lane commands. Depends on `@agentick/client-core` (the
 * `registerSessionHandleExtension` registry + the `ClientHandle`/`Enumerable`
 * contract) — NOT on the state harness runtime. Mirrors the `/react` subpath
 * convention: a harness package MAY add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `state/*` valid `WireMethods` rows for the
// client handle's `transport.request("state/…", …)` — WITHOUT the server
// augmentations (zero runtime).
import "../wire-augment.js";

export { stateHandle, type StateClientHandle, type StateCommandClient } from "./state-handle.js";

// Side-effect: contribute `session.state` to the client SessionHandle (ADR 87).
import "./register.js";
