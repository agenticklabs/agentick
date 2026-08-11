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
  // ── Model (executor) — the provider call is command-ified (ADR 89 §1):
  //    `generate` / `generate_stream` are `command` / `commandStream` verbs. ──
  ["model:command:project", "onBeforeModelProject", "onAfterModelProject"],
  ["model:command:generate", "onBeforeModelGenerate", "onAfterModelGenerate"],
  ["model:command:generate_stream", "onBeforeModelGenerateStream", "onAfterModelGenerateStream"],
  ["model:command:normalize", "onBeforeModelNormalize", "onAfterModelNormalize"],
  ["model:command:run", "onBeforeModelRun", "onAfterModelRun"],
  // ── Compile (compiler) ──
  ["compiler:command:render-tree", "onBeforeCompilerRenderTree", "onAfterCompilerRenderTree"],
  ["compiler:command:mount", "onBeforeCompilerMount", "onAfterCompilerMount"],
  ["compiler:command:rerender", "onBeforeCompilerRerender", "onAfterCompilerRerender"],
  [
    "compiler:command:render-to-string",
    "onBeforeCompilerRenderToString",
    "onAfterCompilerRenderToString",
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
    "tool:command:replace-compiler-tools",
    "onBeforeToolReplaceCompilerTools",
    "onAfterToolReplaceCompilerTools",
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
  // ── Code ──
  ["code:command:execute", "onBeforeCodeExecute", "onAfterCodeExecute"],
  // ── Gateway ──
  ["gateway:command:start", "onBeforeGatewayStart", "onAfterGatewayStart"],
  ["gateway:command:close", "onBeforeGatewayClose", "onAfterGatewayClose"],
  ["gateway:command:create-app", "onBeforeGatewayCreateApp", "onAfterGatewayCreateApp"],
  ["gateway:command:accept", "onBeforeGatewayAccept", "onAfterGatewayAccept"],
  // ── Authorizer (ADR 84 §5 — the fine contextual auth layer) ──
  ["authorizer:command:authorize", "onBeforeAuthorizerAuthorize", "onAfterAuthorizerAuthorize"],
];

/**
 * GATEWAY wire-dispatch ops (ADR 83 §"Wire dispatch through the seam"). The op
 * name is `wire:<method>` — NO `:command:` infix — so the derivation splits on
 * `:` (the `wire` prefix), `/` (the wire namespace separator), AND `_` (snake
 * method segments). These names are the runtime twin of the type-level
 * `Pascal<K>` that `WireCommandMap` → `CommandHooks` mints for each `WireMethods`
 * row (`wire-command-hooks.type.spec.ts` pins the TYPE side). The `wire:` prefix
 * keeps them distinct from the domain op they delegate to (`wire:session/send` →
 * `WireSessionSend`, NOT the `session:send` op's `SessionSend`).
 */
const WIRE_VERBS: ReadonlyArray<readonly [op: string, onBefore: string, onAfter: string]> = [
  ["wire:session/send", "onBeforeWireSessionSend", "onAfterWireSessionSend"],
  ["wire:knobs/set", "onBeforeWireKnobsSet", "onAfterWireKnobsSet"],
  // snake_case method segment — `run_once` must split on `_` (not mangle to `Run_once`).
  ["wire:app/run_once", "onBeforeWireAppRunOnce", "onAfterWireAppRunOnce"],
  // camelCase method segment survives verbatim after its first char caps — the
  // adopter-augmentation shape the type-level lockstep also pins.
  ["wire:crm/deleteContact", "onBeforeWireCrmDeleteContact", "onAfterWireCrmDeleteContact"],
];

/**
 * Verbs NOT augmented (deferred) — the async-seam boundary. Their derived
 * names are pinned so the doc stays honest, but no `CommandRegistry` entry
 * exists (typing them would mint hooks that never fire — see ADR 83
 * §hookability). `compiler:unmount` is deferred the same way: its teardown
 * does not route through `runOperation`.
 */
const DEFERRED_VERBS: ReadonlyArray<readonly [op: string, onBefore: string, onAfter: string]> = [
  ["tasks:command:submit", "onBeforeTasksSubmit", "onAfterTasksSubmit"],
  ["tasks:command:settle", "onBeforeTasksSettle", "onAfterTasksSettle"],
  ["compiler:command:unmount", "onBeforeCompilerUnmount", "onAfterCompilerUnmount"],
];

describe("hook lifecycle — name-derivation lock (ADR 83)", () => {
  describe("typed verbs (hooks fire)", () => {
    for (const [op, onBefore, onAfter] of TYPED_VERBS) {
      it(`deriveHookNames(${JSON.stringify(op)}) → [${onBefore}, ${onAfter}]`, () => {
        expect(deriveHookNames(op)).toEqual([onBefore, onAfter]);
      });
    }
  });

  describe("gateway wire ops (hooks fire at the wire-dispatch boundary)", () => {
    for (const [op, onBefore, onAfter] of WIRE_VERBS) {
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
