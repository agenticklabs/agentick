/**
 * `@agentick/prompts/client` — the client-side projection of the prompt
 * library (ADR 87). The wire twin of the server `session.prompts`.
 *
 * RPC-backed: `list()`/`get()` read a local snapshot polled from `prompts/list`
 * (eager seed + re-poll after each mutation), and the verbs ride the `prompts/*`
 * dynamic-lane commands. Depends on `@agentick/client-core` (the
 * `registerSessionHandleExtension` registry + the `ClientHandle`/`Enumerable`
 * contract) — NOT on the prompts harness runtime. Mirrors the `/react` subpath
 * convention: a harness package MAY add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `prompts/*` valid `WireMethods` rows for the
// client handle's `transport.request("prompts/…", …)` — WITHOUT the server
// augmentations (zero runtime).
import "../wire-augment.js";

export {
  promptsHandle,
  type PromptsClientHandle,
  type PromptsCommandClient,
} from "./prompts-handle.js";

// Side-effect: contribute `session.prompts` to the client SessionHandle (ADR 87).
import "./register.js";
