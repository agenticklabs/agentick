/**
 * Command-hook naming lock (ADR 80 / 83) for the tasks surface.
 *
 * The tasks verbs are NOT yet routed through `runOperation`, so no
 * `onBefore…`/`onAfter…` hook FIRES today — `submit` returns
 * `TaskHandle<T>` synchronously and the interceptor seam is async
 * (see the NOTEs in `harness.ts` at `submit` and `applyTransition`).
 *
 * This test locks the NAMES those verbs WOULD mint once the wiring
 * lands, so the `CommandRegistry` augmentation + docs can be written
 * against a verified derivation rather than a guess. `deriveHookNames`
 * is the shipped runtime function; asserting it here is a real, passing
 * contract lock, not a claim that submit is hookable.
 */

import { describe, expect, it } from "vitest";
import { deriveHookNames } from "@agentick/runtime-next";

describe("tasks — command-hook name derivation (wiring deferred, see harness NOTEs)", () => {
  it("tasks:command:submit derives onBeforeTasksSubmit / onAfterTasksSubmit", () => {
    expect(deriveHookNames("tasks:command:submit")).toEqual([
      "onBeforeTasksSubmit",
      "onAfterTasksSubmit",
    ]);
  });

  it("tasks:command:settle derives onBeforeTasksSettle / onAfterTasksSettle", () => {
    expect(deriveHookNames("tasks:command:settle")).toEqual([
      "onBeforeTasksSettle",
      "onAfterTasksSettle",
    ]);
  });
});
