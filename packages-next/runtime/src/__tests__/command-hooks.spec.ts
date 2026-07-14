/**
 * Command lifecycle hooks (ADR 80 mechanism, ADR 82 collection) — the intrinsic
 * observe/transform seam `BaseHarness.runOperation` endows on every declared
 * command.
 *
 * These pin the mechanism: the name derivation (`deriveHookNames`), the
 * type↔runtime lockstep, the `Hooks.from`/`forOp` consistency, the
 * transform/observe/veto contract, the `Hooks.extend` COMPOSE (ADR 82 — the
 * cascade is a construction-fold, not a parent-walk), and — crucially — that a
 * hook rides the SAME `liftMiddleware` path as `.use` (fiber preservation),
 * never a side-path.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime, Option, Tracer } from "effect";
import { waitFor } from "@agentick/utils-next/testing";
import { HandlerError } from "@agentick/spec-next";
import type {
  MessageEnvelope,
  MessageHandlerError,
  Middleware,
  Operation,
} from "@agentick/spec-next";
import {
  BaseHarness,
  deriveHookNames,
  Hooks,
  type CommandHooks,
} from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";
import type { RuntimeContext } from "../substrate/runtime-context.js";

// Contribute a test verb so the mapped `CommandHooks` mints typed
// `onBeforeToolProbe` / `onAfterToolProbe` — the type-level twin of
// `deriveHookNames("tool:command:probe")`.
interface ProbeInput {
  readonly value: number;
}
type ProbeOutput = number;

declare module "../substrate/base-harness.js" {
  interface CommandRegistry {
    "tool:probe": { input: ProbeInput; output: ProbeOutput };
  }
}

class HookTestHarness extends BaseHarness<"tool"> {
  /** Public probe method (command path — auto opId, empty scope). */
  readonly probe: (input: ProbeInput) => Promise<ProbeOutput>;

  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    opts: { readonly hooks?: Hooks } = {},
  ) {
    super("tool", scopeId, journal, bus, inbox, {
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    });
    this.probe = this.command<ProbeInput, ProbeOutput, never>({
      name: "tool:probe",
      handler: (i) => Effect.succeed(i.value),
    });
  }

  /** Run a caller-supplied body under the `tool:command:probe` op name so the
   *  probe hooks fire while the test controls the body (spans, hangs). */
  runProbeOpEffect(
    opId: string,
    body: (i: ProbeInput) => Effect.Effect<ProbeOutput, unknown>,
  ): Effect.Effect<ProbeOutput, unknown> {
    const op: Operation<ProbeInput, ProbeOutput, unknown> = {
      opId,
      surface: "tool",
      name: "tool:command:probe",
      scope: { sessionId: "s_1", executionId: "e_1", tickId: "t_1" },
      input: { value: 0 },
    };
    return this.runOperation(op, body);
  }

  runProbeForked(
    opId: string,
    body: (i: ProbeInput) => Effect.Effect<ProbeOutput, unknown>,
  ): Fiber.RuntimeFiber<ProbeOutput, unknown> {
    return Effect.runFork(this.runProbeOpEffect(opId, body));
  }

  /** Expose the local resolved-hooks read for the byte-identity assertion. */
  peekHooks(opName: string): Middleware<unknown, unknown, unknown>[] {
    return this.hookLayer.forOp(opName);
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

async function mkHarness(
  opts: {
    readonly hooks?: Hooks;
  } = {},
): Promise<HookTestHarness> {
  const h = new HookTestHarness(
    "scope-1",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    opts,
  );
  await h.ready;
  return h;
}

/** A tracer that records each span it opens + its parent (mirrors base-harness.spec). */
function collectingTracer() {
  const spans: { name: string; parent: Option.Option<unknown> }[] = [];
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind) => {
      spans.push({ name, parent: parent as Option.Option<unknown> });
      return {
        _tag: "Span",
        spanId: `s${spans.length}`,
        traceId: "t",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: new Map<string, unknown>(),
        links,
        kind,
        sampled: true,
        end() {},
        attribute() {},
        event() {},
        addLinks() {},
      } as unknown as Tracer.Span;
    },
    context: (f) => f(),
  });
  const layer = Layer.mergeAll(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  return { layer: layer as Layer.Layer<never, never, never>, spans };
}

describe("deriveHookNames", () => {
  it("strips the `:command:` infix and PascalCases to on{Before,After}<Who><What>", () => {
    expect(deriveHookNames("tool:command:dispatch")).toEqual([
      "onBeforeToolDispatch",
      "onAfterToolDispatch",
    ]);
  });

  it("PascalCases a multi-segment verb per-segment (first char only)", () => {
    // `Cap` uppercases only the first char — matches the type-level Pascal.
    expect(deriveHookNames("model:command:generate")).toEqual([
      "onBeforeModelGenerate",
      "onAfterModelGenerate",
    ]);
  });

  it("splits on `/` too (wire-method ids)", () => {
    expect(deriveHookNames("knobs/set")).toEqual(["onBeforeKnobsSet", "onAfterKnobsSet"]);
  });

  it("is a total function of the op name — a rename renames its surfaces", () => {
    expect(deriveHookNames("tool:command:execute")).toEqual([
      "onBeforeToolExecute",
      "onAfterToolExecute",
    ]);
  });
});

describe("command hooks — type/runtime lockstep", () => {
  it("deriveHookNames agrees with the type-level Pascal for the same command", () => {
    const names = deriveHookNames("tool:command:probe");
    // `_typed` compiles ONLY because the mapped `CommandHooks` minted exactly
    // `onBeforeToolProbe` / `onAfterToolProbe` for the `"tool:probe"` key —
    // and its keys equal the runtime-derived strings. One transformation,
    // once in the type system, once at runtime; they must agree.
    const _typed: CommandHooks = {
      onBeforeToolProbe: (i) => i,
      onAfterToolProbe: (o) => o,
    };
    expect(names).toEqual(["onBeforeToolProbe", "onAfterToolProbe"]);
    expect(Object.keys(_typed).sort()).toEqual([...names].sort());
  });
});

describe("command hooks — transform contract", () => {
  it("onBefore reshapes the input the handler sees; onAfter reshapes the output", async () => {
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: (input) => ({ value: input.value * 2 }),
        onAfterToolProbe: (out) => out + 100,
      }),
    });
    // handler returns input.value; before doubles (5→10), after adds 100.
    expect(await h.probe({ value: 5 })).toBe(110);
  });

  it("a `void` return is passthrough/observe (input + output untouched)", async () => {
    const seen: number[] = [];
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: (input) => {
          seen.push(input.value);
        },
        onAfterToolProbe: (out) => {
          seen.push(out);
        },
      }),
    });
    expect(await h.probe({ value: 7 })).toBe(7); // unchanged
    expect(seen).toEqual([7, 7]); // observed both faces
  });

  it("a `throw` in onBefore vetoes — the op aborts with the thrown error", async () => {
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: () => {
          throw new Error("blocked");
        },
      }),
    });
    await expect(h.probe({ value: 1 })).rejects.toThrow("blocked");
  });
});

describe("Hooks.from + forOp — indexing and consistency", () => {
  it("forOp returns lifted entries for a hooked op (before then after)", () => {
    const hooks = Hooks.from({
      onBeforeToolProbe: (i) => i,
      onAfterToolProbe: (o) => o,
    });
    expect(hooks.forOp("tool:command:probe")).toHaveLength(2);
  });

  it("Hooks.empty.forOp and an unhooked op both return [] (byte-identical chain)", () => {
    expect(Hooks.empty.forOp("tool:command:probe")).toEqual([]);
    // A populated layer still yields [] for a DIFFERENT op — no accidental match.
    const hooks = Hooks.from({ onBeforeToolProbe: (i) => i });
    expect(hooks.forOp("tool:command:other")).toEqual([]);
  });

  it("from/forOp/deriveHookNames agree — the config key an op derives is the one forOp reads", () => {
    // The SAME command yields hooks; a rename of the op would rename BOTH the
    // config key (`deriveHookNames`) and the `forOp` lookup, so a `from` keyed
    // by one and a `forOp` keyed by the other can never silently diverge.
    const [beforeName, afterName] = deriveHookNames("tool:command:probe");
    const hooks = Hooks.from({
      [beforeName]: (i: ProbeInput) => i,
      [afterName]: (o: ProbeOutput) => o,
    } as CommandHooks);
    expect(hooks.forOp("tool:command:probe")).toHaveLength(2);
    // Only a before-hook present → exactly one entry for that op.
    expect(
      Hooks.from({ [beforeName]: (i: ProbeInput) => i } as CommandHooks).forOp(
        "tool:command:probe",
      ),
    ).toHaveLength(1);
  });
});

describe("Hooks.extend — composes (ADR 82), not overrides", () => {
  it("two layers both setting onBeforeToolProbe BOTH fire, outer-first", async () => {
    // App layer (outer) sees input first; session layer (inner) second.
    // Outer doubles (5→10), inner adds one (10→11); the handler returns 11.
    const resolved = Hooks.from({ onBeforeToolProbe: (i) => ({ value: i.value * 2 }) }).extend(
      Hooks.from({ onBeforeToolProbe: (i) => ({ value: i.value + 1 }) }),
    );
    const h = await mkHarness({ hooks: resolved });
    expect(await h.probe({ value: 5 })).toBe(11);
  });

  it("onion order across the folded layers — outer before/after bracket the inner", async () => {
    const order: string[] = [];
    const resolved = Hooks.from({
      onBeforeToolProbe: (i) => {
        order.push("app:before");
        return i;
      },
      onAfterToolProbe: (o) => {
        order.push("app:after");
        return o;
      },
    }).extend(
      Hooks.from({
        onBeforeToolProbe: (i) => {
          order.push("session:before");
          return i;
        },
        onAfterToolProbe: (o) => {
          order.push("session:after");
          return o;
        },
      }),
    );
    const h = await mkHarness({ hooks: resolved });
    await h.probe({ value: 0 });
    expect(order).toEqual(["app:before", "session:before", "session:after", "app:after"]);
  });

  it("extend is immutable and empty is its identity", () => {
    const layer = Hooks.from({ onBeforeToolProbe: (i) => i });
    expect(layer.extend(Hooks.empty)).toBe(layer); // right identity — no realloc
    expect(Hooks.empty.extend(layer)).toBe(layer); // left identity
    // A distinct op keeps returning [] on the base layer after extend (no mutation).
    const extended = layer.extend(Hooks.from({ onAfterToolProbe: (o) => o }));
    expect(extended.forOp("tool:command:probe")).toHaveLength(2);
    expect(layer.forOp("tool:command:probe")).toHaveLength(1); // base untouched
  });
});

describe("command hooks — no hooks is behavior-preserving", () => {
  it("with no hooks registered, the resolved Hooks.forOp returns []", async () => {
    const h = await mkHarness();
    expect(h.peekHooks("tool:command:probe")).toEqual([]);
  });
});

describe("command hooks — fiber preservation (rides the .use lift)", () => {
  // A hook desugars to an AsyncMiddleware lifted through `liftMiddleware`. These
  // re-run the ADR-76 characterization THROUGH a hook: if hooks took a side-path
  // instead of the lift, each of these would break.

  it("an awaiting onBefore hook reads the op's RuntimeContext via its ctx arg", async () => {
    let seen: RuntimeContext | undefined;
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: async (input, ctx) => {
          await Promise.resolve();
          seen = ctx; // the lift hands the hook the op's captured ctx
          return input;
        },
      }),
    });
    await Effect.runPromise(h.runProbeOpEffect("op-ctx", () => Effect.succeed(0)));
    expect(seen?.opId).toBe("op-ctx");
    expect(seen?.sessionId).toBe("s_1");
  });

  it("a span opened in the body nests under the op span THROUGH an awaiting hook", async () => {
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: async (input) => {
          await Promise.resolve();
          return input;
        },
      }),
    });
    const { layer, spans } = collectingTracer();
    const runtime = ManagedRuntime.make(layer);
    const body = (): Effect.Effect<ProbeOutput> =>
      Effect.succeed(0).pipe(Effect.withSpan("child-span"));
    await runtime.runPromise(h.runProbeOpEffect("op-span", body));
    await runtime.dispose();

    const child = spans.find((s) => s.name === "child-span");
    expect(child).toBeDefined();
    expect(Option.isSome(child!.parent)).toBe(true);
    const parent = Option.getOrNull(child!.parent) as { name?: string } | null;
    expect(parent?.name).toBe("tool:command:probe");
  });

  it("interrupting the op tears down the body an awaiting hook wraps", async () => {
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: async (input) => {
          await Promise.resolve();
          return input;
        },
      }),
    });
    let started = false;
    let interrupted = false;
    const body = (): Effect.Effect<ProbeOutput> =>
      Effect.gen(function* () {
        started = true;
        yield* Effect.never;
        return 0;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
    const fiber = h.runProbeForked("op-abort", body);
    await waitFor(() => started);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitFor(() => interrupted);
    expect(interrupted).toBe(true);
  });
});

describe("dynamic hooks — hook() + the harness.hooks proxy (ADR 83)", () => {
  it("hook({ onBeforeToolProbe }) fires on a probe; the Unsubscribe removes it", async () => {
    const h = await mkHarness();
    let seen: number | undefined;
    const off = h.hook({
      onBeforeToolProbe: (input) => {
        seen = input.value;
      },
    });
    await h.probe({ value: 7 });
    expect(seen).toBe(7);

    seen = undefined;
    off();
    await h.probe({ value: 9 });
    expect(seen).toBeUndefined(); // removed — the exact fn was dropped
  });

  it("harness.hooks.onBeforeToolProbe(fn) — per-verb proxy sugar — fires + removes", async () => {
    const h = await mkHarness();
    let seen: number | undefined;
    const off = h.hooks.onBeforeToolProbe((input) => {
      seen = input.value;
    });
    await h.probe({ value: 3 });
    expect(seen).toBe(3);

    seen = undefined;
    off();
    await h.probe({ value: 4 });
    expect(seen).toBeUndefined();
  });

  it("harness.hooks.onAfterToolProbe(fn) transforms the output", async () => {
    const h = await mkHarness();
    h.hooks.onAfterToolProbe((output) => output * 10);
    expect(await h.probe({ value: 5 })).toBe(50);
  });

  it("a construction hook and a dynamically-added hook both fire (compose, construction-outer)", async () => {
    const order: string[] = [];
    const h = await mkHarness({
      hooks: Hooks.from({
        onBeforeToolProbe: () => {
          order.push("construction");
        },
      }),
    });
    h.hook({
      onBeforeToolProbe: () => {
        order.push("dynamic");
      },
    });
    await h.probe({ value: 1 });
    expect(order).toEqual(["construction", "dynamic"]);
  });
});
