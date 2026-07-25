/**
 * `@agentick/resources/client` — the client-side projection of the
 * resource registry (ADR 87). The wire twin of the server `session.resources`.
 *
 * RPC-backed: `list()`/`get()` read a local snapshot polled from
 * `resources/list` (eager seed + explicit `refresh()`), and `listTemplates()` /
 * `read(uri)` ride the `resources/*` dynamic-lane commands. Depends on
 * `@agentick/client-core` (the `registerSessionHandleExtension` registry +
 * the `ClientHandle`/`Enumerable` contract) — NOT on the resources harness
 * runtime. Mirrors the `/react` subpath convention: a harness package MAY add a
 * `/client` surface that depends on the generic client without pulling the
 * server harness into a browser bundle.
 */

// Type-only side effect: makes `resources/*` valid `WireMethods` rows for the
// client handle's `transport.request("resources/…", …)` — WITHOUT the server
// augmentations (zero runtime).
import "../wire-augment.js";

export {
  resourcesHandle,
  type ResourcesClientHandle,
  type ResourcesCommandClient,
} from "./resources-handle.js";

// Side-effect: contribute `session.resources` to the client SessionHandle (ADR 87).
import "./register.js";
