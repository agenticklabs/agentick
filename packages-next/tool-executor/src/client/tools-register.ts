/**
 * ADR 87 — contribute `session.tools` to the client `SessionHandle`.
 *
 * Importing `@agentick/tool-executor-next/client` both TYPES the slot
 * (`declare module`) and REGISTERS the runtime factory, so
 * `client.session(id).tools` self-assembles — the client twin of the server's
 * `session.tools`. It's `toolsHandle`: the {@link ToolInfo} snapshot view
 * (`list`/`get`) plus the `dispatch` wire verb, RPC-backed over
 * `session/list_tools` + `session/dispatch` (no `tools-state` channel yet — see
 * {@link toolsHandle}).
 *
 * The slot name `tools` is DISTINCT from the existing `clientToolCalls` slot
 * (the inbound client-tool-call feed): a client sees BOTH — the tool registry
 * projection AND the respond/route/confirm surface.
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";

import { toolsHandle, type ToolsClientHandle } from "./tools-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The tools resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(name)` over the tool snapshot (Enumerable), the zero-arg
     * `subscribe(cb)` store contract, and `dispatch(name, input)` over the
     * `session/dispatch` wire command (`== toolsHandle(client, id)`). Distinct
     * from `clientToolCalls` (the inbound client-tool-call feed).
     */
    readonly tools: ToolsClientHandle;
  }
}

registerSessionHandleExtension("tools", (client, sessionId) => toolsHandle(client, sessionId));
