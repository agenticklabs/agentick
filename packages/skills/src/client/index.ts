/**
 * `@agentick/skills/client` — the client-side projection of the skill
 * library (ADR 87). The wire twin of the server `session.skills`.
 *
 * RPC-backed: `list()`/`get()` read a local snapshot polled from `skills/list`
 * (eager seed + re-poll after each mutation), and the verbs ride the `skills/*`
 * dynamic-lane commands. Depends on `@agentick/client-core` (the
 * `registerSessionHandleExtension` registry + the `ClientHandle`/`Enumerable`
 * contract) — NOT on the skills harness runtime. Mirrors the `/react` subpath
 * convention: a harness package MAY add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `skills/*` valid `WireMethods` rows for the
// client handle's `transport.request("skills/…", …)` — WITHOUT the server
// augmentations (zero runtime).
import "../wire-augment.js";
// Type-only side effect: types `entry.metadata.source.skill` for the chat
// projection that renders a skill run as a pill instead of the whole document.
import "../message-source.js";

export type { SkillMessageSource } from "../message-source.js";

export {
  skillsHandle,
  type SkillsClientHandle,
  type SkillsCommandClient,
} from "./skills-handle.js";

// Side-effect: contribute `session.skills` to the client SessionHandle (ADR 87).
import "./register.js";
