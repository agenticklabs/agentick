/**
 * Hook-lifecycle NAME-DERIVATION LOCK (ADR 80/83).
 *
 * The `CommandRegistry` augmentations in the harness packages type each
 * built-in lifecycle verb, minting `on<Pascal>` (full middleware),
 * `onBefore<Pascal>`, and `onAfter<Pascal>` on the derived `CommandHooks`
 * surface. This test pins the runtime {@link deriveHookNames} — the twin of the
 * type-level `Pascal<K>` — for every verb in the taxonomy, so
 * `docs/proposals/v2/HOOK-LIFECYCLE.md` and the generated hook names cannot
 * silently drift apart.
 *
 * Each row is `[opName, onBefore, onAfter]`. `deriveHookNames` strips the
 * `:command:` infix and PascalCases, splitting on `:` / `/` / `-`. The full
 * middleware name is `on<Pascal>` — the shared `Pascal` suffix of both hooks
 * (asserted structurally below).
 */

import { describe, expect, it } from "vitest";

import { deriveHookNames } from "../index.js";

/** Verbs augmented into `CommandRegistry` (typed — hooks fire). */
const TYPED_VERBS: ReadonlyArray<readonly [op: string, onBefore: string, onAfter: string]> = [
  // ── Execution ──
  ["loop:command:run-execution", "onBeforeLoopRunExecution", "onAfterLoopRunExecution"],
  // ── Model (executor) ──
  ["executor:command:project", "onBeforeExecutorProject", "onAfterExecutorProject"],
  ["executor:command:execute", "onBeforeExecutorExecute", "onAfterExecutorExecute"],
  ["executor:command:run", "onBeforeExecutorRun", "onAfterExecutorRun"],
  ["executor:command:normalize", "onBeforeExecutorNormalize", "onAfterExecutorNormalize"],
  // ── Compile (reconciler) ──
  ["reconciler:command:render-tree", "onBeforeReconcilerRenderTree", "onAfterReconcilerRenderTree"],
  ["reconciler:command:mount", "onBeforeReconcilerMount", "onAfterReconcilerMount"],
  ["reconciler:command:rerender", "onBeforeReconcilerRerender", "onAfterReconcilerRerender"],
  [
    "reconciler:command:render-to-string",
    "onBeforeReconcilerRenderToString",
    "onAfterReconcilerRenderToString",
  ],
  // ── App ──
  ["app:command:create-session", "onBeforeAppCreateSession", "onAfterAppCreateSession"],
  ["app:command:run-once", "onBeforeAppRunOnce", "onAfterAppRunOnce"],
  ["app:command:close-app", "onBeforeAppCloseApp", "onAfterAppCloseApp"],
  // ── Tool ──
  ["tool:command:dispatch", "onBeforeToolDispatch", "onAfterToolDispatch"],
  ["tool:command:abort", "onBeforeToolAbort", "onAfterToolAbort"],
  ["tool:command:register", "onBeforeToolRegister", "onAfterToolRegister"],
  ["tool:command:unregister", "onBeforeToolUnregister", "onAfterToolUnregister"],
  [
    "tool:command:remove-bound-tools",
    "onBeforeToolRemoveBoundTools",
    "onAfterToolRemoveBoundTools",
  ],
  [
    "tool:command:replace-reconciler-tools",
    "onBeforeToolReplaceReconcilerTools",
    "onAfterToolReplaceReconcilerTools",
  ],
  // ── Timeline ──
  ["timeline:command:compact", "onBeforeTimelineCompact", "onAfterTimelineCompact"],
  // ── Elicitation ──
  ["elicitation:command:elicit", "onBeforeElicitationElicit", "onAfterElicitationElicit"],
  // ── Session ──
  ["session:command:send", "onBeforeSessionSend", "onAfterSessionSend"],
  ["session:command:append", "onBeforeSessionAppend", "onAfterSessionAppend"],
  [
    "session:command:apply-executor-result",
    "onBeforeSessionApplyExecutorResult",
    "onAfterSessionApplyExecutorResult",
  ],
  [
    "session:command:apply-tool-results",
    "onBeforeSessionApplyToolResults",
    "onAfterSessionApplyToolResults",
  ],
  // ── Sandbox ──
  ["sandbox:command:exec", "onBeforeSandboxExec", "onAfterSandboxExec"],
  // ── Gateway ──
  ["gateway:command:start", "onBeforeGatewayStart", "onAfterGatewayStart"],
  ["gateway:command:close", "onBeforeGatewayClose", "onAfterGatewayClose"],
];

/**
 * Verbs NOT augmented (deferred) — the async-seam boundary. Their derived
 * names are pinned so the doc stays honest, but no `CommandRegistry` entry
 * exists (typing them would mint hooks that never fire — see ADR 83
 * §hookability). `reconciler:unmount` is deferred the same way: its teardown
 * does not route through `runOperation`.
 */
const DEFERRED_VERBS: ReadonlyArray<readonly [op: string, onBefore: string, onAfter: string]> = [
  ["tasks:command:submit", "onBeforeTasksSubmit", "onAfterTasksSubmit"],
  ["tasks:command:settle", "onBeforeTasksSettle", "onAfterTasksSettle"],
  ["reconciler:command:unmount", "onBeforeReconcilerUnmount", "onAfterReconcilerUnmount"],
];

describe("hook lifecycle — name-derivation lock (ADR 83)", () => {
  describe("typed verbs (hooks fire)", () => {
    for (const [op, onBefore, onAfter] of TYPED_VERBS) {
      it(`deriveHookNames(${JSON.stringify(op)}) → [${onBefore}, ${onAfter}]`, () => {
        expect(deriveHookNames(op)).toEqual([onBefore, onAfter]);
      });
    }
  });

  describe("deferred verbs (names reserved, no hook fires)", () => {
    for (const [op, onBefore, onAfter] of DEFERRED_VERBS) {
      it(`deriveHookNames(${JSON.stringify(op)}) → [${onBefore}, ${onAfter}]`, () => {
        expect(deriveHookNames(op)).toEqual([onBefore, onAfter]);
      });
    }
  });

  it("the full-middleware name is the shared Pascal suffix of both sugar hooks", () => {
    // `on<Pascal>` === `onBefore<Pascal>` with the "Before" elided, i.e. the
    // common suffix after the `onBefore` / `onAfter` prefixes.
    for (const [, onBefore, onAfter] of TYPED_VERBS) {
      const pascal = onBefore.slice("onBefore".length);
      expect(onAfter.slice("onAfter".length)).toBe(pascal);
      expect(`on${pascal}`).toMatch(/^on[A-Z]/);
    }
  });
});
