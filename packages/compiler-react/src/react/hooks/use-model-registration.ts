/**
 * `useModelRegistration` — the render-time half of ADR 56's tree-declared
 * per-tick model, mirroring `createTool`'s `Tool` component verbatim.
 *
 * Two jobs, exactly as the tool pattern splits them:
 *
 *   1. **Live side** — registers the run-ready {@link RegisteredModel} on
 *      the session's {@link ModelBridge} (via `useModelBridge`), keyed by
 *      `modelRef`, and unregisters on unmount. This is the analogue of
 *      the `Tool` component's `useEffect(() => bridge.register(...))`.
 *
 *   2. **IR side** — contributes `declarations.model = { modelRef,
 *      parameters }` to THIS render's IR by RETURNING the
 *      `<model-declaration>` host intrinsic. The caller renders it. This
 *      is the analogue of the `Tool` component's
 *      `return React.createElement("tool", ...)`.
 *
 * **Why this returns a `ReactElement`, not `void`.** Declarations enter
 * the IR through exactly one path: `collect()` walks the committed host
 * tree and dispatches each host element to a contributor. There is no
 * render-scoped side channel — a `void` hook cannot contribute to the
 * synchronous IR without inventing a parallel mechanism (which ADR 56
 * explicitly forbids: "follow the real path"). `createTool` faces the
 * identical constraint and resolves it by having the `Tool` component
 * RETURN the `<tool>` intrinsic. `useModelRegistration` returns the
 * `<model-declaration>` intrinsic for the caller to render — the exact
 * same mechanism.
 *
 * The `resolved` is spec-typed {@link RegisteredModel} — this hook never
 * imports `@agentick/model`. The deferred `<Model model={adapter}>`
 * sugar (slice 1) derives `resolved` from a live adapter and renders
 * whatever this hook returns.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */

import * as React from "react";

import type { RegisteredModel } from "@agentick/spec";

import { useModelBridge } from "./use-model-bridge.js";

export function useModelRegistration(
  modelRef: string,
  resolved: RegisteredModel,
): React.ReactElement {
  const bridge = useModelBridge();

  // Live side: register on the bridge across the effect lifecycle.
  // Re-registers when the bridge, ref, or resolved value changes
  // (last-writer-wins on the same ref, matching ToolBridge semantics).
  React.useEffect(() => {
    if (!bridge) return;
    const unregister = bridge.register(modelRef, resolved);
    return () => {
      unregister();
    };
  }, [bridge, modelRef, resolved]);

  // IR side: contribute declarations.model for this render via the host
  // intrinsic the collector picks up — the same path `<tool>` uses. The
  // core hook declares only the `modelRef`; per-tick generation
  // `parameters` (the optional `ModelDeclaration.parameters`) are set by
  // the deferred `<Model>` sugar (slice 1), which renders the intrinsic
  // with a `parameters` prop the contributor already reads.
  return React.createElement("model-declaration", { modelRef });
}
