/**
 * `fakeCompiler()` — minimal working `CompilerFactory` for tests
 * that need a compiler to exist but do NOT exercise rendering.
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
 *     `reactCompiler()` from `@agentick/compiler-react`.
 *   - Tests that check IR diagnostics (warnings/errors surface
 *     correctly) MUST use the real compiler.
 *   - Tests that observe lifecycle callbacks under real React mount
 *     semantics MUST use the real compiler.
 *
 * Using this fake for any rendering-coupled test will produce false
 * green tests — the fake's empty IR satisfies the contract surface
 * without exercising the real renderer.
 *
 * ## Type discipline
 *
 * The factory is typed against `CompilerFactory` from
 * `@agentick/spec` (via `defineCompiler`). When the protocol
 * changes, this fake fails to compile.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type { RenderTreeResult } from "@agentick/spec";

import { defineCompiler } from "../define-compiler.js";

export function fakeCompiler(): ReturnType<typeof defineCompiler> {
  return defineCompiler({
    mount: async () => ({
      mountId: "fake-compiler-mount",
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
