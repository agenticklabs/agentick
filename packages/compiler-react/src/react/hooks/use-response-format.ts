import { useContext } from "react";
import type { RenderContext } from "@agentick/spec";
import { RenderContextContext } from "../render-context-context.js";

/** The output shape the current send is bound to. */
export type BoundResponseFormat = NonNullable<RenderContext["responseFormat"]>;

/**
 * `useResponseFormat` — the output shape THIS send is bound to
 * (`SendInput.responseFormat`), read synchronously from the
 * {@link RenderContext} envelope. Same seam and timing as `useActiveModel`.
 *
 * An EXPOSURE, not a mechanism: render the bound schema at context BOTTOM so
 * a per-send shape never enters the tools block, which is a cache prefix and
 * must stay byte-stable. The framework validates nothing against it and ships
 * no output-contract component — that is application code. Its dispatch-time
 * twin is `ctx.responseFormat` on a tool handler.
 *
 * Returns `undefined` when the send carried no `responseFormat`.
 */
export function useResponseFormat(): BoundResponseFormat | undefined {
  return useContext(RenderContextContext)?.responseFormat;
}
