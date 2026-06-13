/**
 * `fakeReconciler()` — minimal working `ReconcilerFactory` for tests
 * that need a reconciler to exist but do NOT exercise rendering.
 *
 * Returns a factory whose `mount`/`renderTree`/`unmount` are pass-through
 * no-ops. The rendered IR is always an empty `{ context: { entries: [] },
 * declarations: {} }` tree.
 *
 * ## When to use
 *
 * **YES — orthogonal-to-rendering tests:**
 *   - Wire-path tests that need a session to exist (e.g., session/send
 *     end-to-end against a `FakeLanguageModelExecutor` that ignores the
 *     prompt — the executor's scripted output drives the test, the
 *     rendered tree is irrelevant).
 *   - Lifecycle tests that observe app/session creation but never call
 *     render.
 *   - Cross-layer integration tests where rendering is mocked at a
 *     coarser boundary.
 *
 * **NO — rendering tests:**
 *   - Tests that verify component output (knobs render as expected,
 *     contributors emit fragments, etc.) MUST use the real
 *     `reactReconciler()` from `@agentick/reconciler-react-next`.
 *   - Tests that check IR diagnostics (warnings/errors surface
 *     correctly) MUST use the real reconciler.
 *   - Tests that observe lifecycle callbacks under real React mount
 *     semantics MUST use the real reconciler.
 *
 * Using this fake for any rendering-coupled test will produce false
 * green tests — the fake's empty IR satisfies the contract surface
 * without exercising the real renderer.
 *
 * ## Type discipline
 *
 * The factory is typed against `ReconcilerFactory` from
 * `@agentick/spec-next` (via `defineReconciler`). When the protocol
 * changes, this fake fails to compile.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type { RenderTreeResult } from "@agentick/spec-next";

import { defineReconciler } from "../define-reconciler.js";

export function fakeReconciler(): ReturnType<typeof defineReconciler> {
  return defineReconciler({
    mount: async () => ({
      mountId: "fake-reconciler-mount",
      restoredFromSnapshot: false,
    }),
    unmount: async () => {},
    renderTree: async () =>
      ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tree: { context: { entries: [] }, declarations: {} } as any,
        diagnostics: [],
        iterations: 1,
      }) satisfies RenderTreeResult,
  });
}
