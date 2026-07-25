/**
 * `CallbackCompiler.fx.renderTree` — the dual-typed edge on the callback
 * compiler (ADR 77 Stage 2). `renderTree` builds its Operation inline
 * (not a registry command), so `.fx` hand-exposes the `runOperation(op,
 * body)` Effect the facade already builds — un-run.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  CompilerProtocol,
  RenderTreeInput,
  RenderTreeResult,
  RenderedTree,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { defineCompiler } from "../define-compiler.js";

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };
const result = (): RenderTreeResult => ({
  tree: { ...EMPTY_TREE },
  diagnostics: [],
  iterations: 1,
});

function makeCompiler(): CompilerProtocol {
  const factory = defineCompiler({
    mount: async () => ({ mountId: "m", restoredFromSnapshot: false }),
    unmount: async () => {},
    renderTree: async () => result(),
  });
  return factory({
    scopeId: "r_fx",
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  });
}

const input = (): RenderTreeInput => ({ mountId: "m", sessionId: "s" });

describe("CallbackCompiler — .fx.renderTree dual-typed edge", () => {
  it("fx.renderTree returns a composable Effect (not a Promise)", async () => {
    const r = makeCompiler();
    const eff = r.fx.renderTree(input());

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);

    const out = await Effect.runPromise(eff);
    expect(out.iterations).toBe(1);
  });

  it("the plain renderTree() is the Promise facade", async () => {
    const r = makeCompiler();
    const p = r.renderTree(input());

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);
    expect((await p).iterations).toBe(1);
  });

  it("fx.renderTree nests in one Effect.gen (single fiber tree)", async () => {
    const r = makeCompiler();
    const [a, b] = await Effect.runPromise(
      Effect.gen(function* () {
        const r1 = yield* r.fx.renderTree(input());
        const r2 = yield* r.fx.renderTree(input());
        return [r1, r2] as const;
      }),
    );
    expect(a.iterations).toBe(1);
    expect(b.iterations).toBe(1);
  });
});
