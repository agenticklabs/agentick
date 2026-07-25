/**
 * ADR 87 — contribute `session.skills` to the client `SessionHandle`.
 *
 * Importing `@agentick/skills/client` both TYPES the slot (`declare
 * module`) and REGISTERS the runtime factory, so `client.session(id).skills`
 * self-assembles — the client twin of the server's `session.skills`. It's
 * `skillsHandle`: the {@link Skill} snapshot view (`list`/`get`) plus the
 * `search`/`register`/`update`/`remove` wire verbs, RPC-backed (no
 * `skills-state` channel — see {@link skillsHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import { skillsHandle, type SkillsClientHandle } from "./skills-handle.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The skills resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(name)` over the skill snapshot (Enumerable), the zero-arg
     * `subscribe(cb)` store contract, `search(input)`, and
     * `register`/`update`/`remove` over the `skills/*` wire commands
     * (`== skillsHandle(client, id)`).
     */
    readonly skills: SkillsClientHandle;
  }
}

registerSessionHandleExtension("skills", (client, sessionId) => skillsHandle(client, sessionId));
