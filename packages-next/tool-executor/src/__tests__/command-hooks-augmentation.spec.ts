/**
 * ADR 80 — proof that this package's `CommandRegistry` augmentation for the
 * `tool:dispatch` verb (see `harness.ts`) mints correctly-typed
 * `onBeforeToolDispatch` / `onAfterToolDispatch` hooks, and that the type-level
 * name derivation agrees with the runtime `deriveHookNames`.
 *
 * The behavioral mechanism (transform / veto / cascade / fiber preservation)
 * is proven generically in `@agentick/runtime-next`'s `command-hooks.spec.ts`;
 * this file only proves the augmentation wired up here resolves.
 */

import { describe, expect, it } from "vitest";
import { deriveHookNames, type CommandHooks } from "@agentick/runtime-next";
import type { ContentBlock, DispatchInput } from "@agentick/spec-next";

describe("tool:dispatch command hooks — augmentation", () => {
  it("mints onBeforeToolDispatch (input ← DispatchInput) + onAfterToolDispatch (output ← ContentBlock[])", () => {
    // Compiles ONLY because the augmentation typed these hooks over the real
    // DispatchInput / ContentBlock[] currency. The `input.name` / spread reads
    // pin the input/output types precisely.
    const hooks: CommandHooks = {
      onBeforeToolDispatch: (input: DispatchInput) => ({ ...input, name: input.name }),
      onAfterToolDispatch: (output: readonly ContentBlock[]) => [...output],
    };
    expect(typeof hooks.onBeforeToolDispatch).toBe("function");
    expect(typeof hooks.onAfterToolDispatch).toBe("function");
  });

  it("deriveHookNames('tool:command:dispatch') matches the mapped-type hook names (lockstep)", () => {
    const names = deriveHookNames("tool:command:dispatch");
    const typed: CommandHooks = {
      onBeforeToolDispatch: (i) => i,
      onAfterToolDispatch: (o) => o,
    };
    expect(names).toEqual(["onBeforeToolDispatch", "onAfterToolDispatch"]);
    expect(Object.keys(typed).sort()).toEqual([...names].sort());
  });
});
