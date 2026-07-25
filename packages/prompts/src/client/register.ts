/**
 * ADR 87 — contribute `session.prompts` to the client `SessionHandle`.
 *
 * Importing `@agentick/prompts/client` both TYPES the slot (`declare
 * module`) and REGISTERS the runtime factory, so `client.session(id).prompts`
 * self-assembles — the client twin of the server's `session.prompts`. It's
 * `promptsHandle`: the {@link PromptDeclarationRecord} snapshot view
 * (`list`/`get`) plus the `render`/`invoke`/`register`/`update`/`remove` wire
 * verbs, RPC-backed (no `prompts-state` channel — see {@link promptsHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import { promptsHandle, type PromptsClientHandle } from "./prompts-handle.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The prompts resource handle — the `ClientHandle` contract for this
     * session: `list()`/`get(name)` over the declaration snapshot (Enumerable),
     * the zero-arg `subscribe(cb)` store contract, `render`/`invoke`, and
     * `register`/`update`/`remove` over the `prompts/*` wire commands
     * (`== promptsHandle(client, id)`).
     */
    readonly prompts: PromptsClientHandle;
  }
}

registerSessionHandleExtension("prompts", (client, sessionId) => promptsHandle(client, sessionId));
