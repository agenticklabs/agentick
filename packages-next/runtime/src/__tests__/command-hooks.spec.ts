/**
 * Command lifecycle hooks (ADR 80) — the intrinsic observe/transform seam
 * `BaseHarness.runOperation` endows on every declared command.
 *
 * These pin the mechanism: the name derivation (`deriveHookNames`), the
 * type↔runtime lockstep, the transform/observe/veto contract, the cascade
 * across construction ancestors, and — crucially — that a hook rides the SAME
 * `liftMiddleware` path as `.use` (fiber preservation), never a side-path.
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
import { BaseHarness, deriveHookNames, type CommandHooks } from "../substrate/base-harness.js";
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

class HookTestHarness extends BaseHarness<"tool", HookTestHarness> {
  /** Public probe method (command path — auto opId, empty scope). */
  readonly probe: (input: ProbeInput) => Promise<ProbeOutput>;

  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    opts: { readonly hooks?: CommandHooks; readonly parent?: HookTestHarness } = {},
  ) {
    super("tool", scopeId, journal, bus, inbox, {
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
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

  /** Expose the protected collector for the byte-identity assertion. */
  peekHooks(opName: string): Middleware<unknown, unknown, unknown>[] {
    return this.ownAndInheritedHooks(opName);
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

async function mkHarness(
  opts: {
    readonly hooks?: CommandHooks;
    readonly parent?: HookTestHarness;
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
      hooks: {
        onBeforeToolProbe: (input) => ({ value: input.value * 2 }),
        onAfterToolProbe: (out) => out + 100,
      },
    });
    // handler returns input.value; before doubles (5→10), after adds 100.
    expect(await h.probe({ value: 5 })).toBe(110);
  });

  it("a `void` return is passthrough/observe (input + output untouched)", async () => {
    const seen: number[] = [];
    const h = await mkHarness({
      hooks: {
        onBeforeToolProbe: (input) => {
          seen.push(input.value);
        },
        onAfterToolProbe: (out) => {
          seen.push(out);
        },
      },
    });
    expect(await h.probe({ value: 7 })).toBe(7); // unchanged
    expect(seen).toEqual([7, 7]); // observed both faces
  });

  it("a `throw` in onBefore vetoes — the op aborts with the thrown error", async () => {
    const h = await mkHarness({
      hooks: {
        onBeforeToolProbe: () => {
          throw new Error("blocked");
        },
      },
    });
    await expect(h.probe({ value: 1 })).rejects.toThrow("blocked");
  });
});

describe("command hooks — cascade", () => {
  it("a hook on a PARENT harness fires for a CHILD harness's op", async () => {
    const parent = await mkHarness({
      hooks: { onBeforeToolProbe: (input) => ({ value: input.value + 1 }) },
    });
    const child = new HookTestHarness(
      "child",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { parent },
    );
    await child.ready;
    // Child registered NO hooks; the parent's before-hook still reshapes the
    // child's dispatch (input 41 → 42), proving cascade over the ctor chain.
    expect(await child.probe({ value: 41 })).toBe(42);
  });

  it("parent-before is outermost — onion order across scopes", async () => {
    const order: string[] = [];
    const parent = await mkHarness({
      hooks: {
        onBeforeToolProbe: (i) => {
          order.push("parent:before");
          return i;
        },
        onAfterToolProbe: (o) => {
          order.push("parent:after");
          return o;
        },
      },
    });
    const child = new HookTestHarness(
      "child",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        parent,
        hooks: {
          onBeforeToolProbe: (i) => {
            order.push("child:before");
            return i;
          },
          onAfterToolProbe: (o) => {
            order.push("child:after");
            return o;
          },
        },
      },
    );
    await child.ready;
    await child.probe({ value: 0 });
    expect(order).toEqual(["parent:before", "child:before", "child:after", "parent:after"]);
  });
});

describe("command hooks — no hooks is behavior-preserving", () => {
  it("with no hooks registered anywhere, ownAndInheritedHooks returns []", async () => {
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
      hooks: {
        onBeforeToolProbe: async (input, ctx) => {
          await Promise.resolve();
          seen = ctx; // the lift hands the hook the op's captured ctx
          return input;
        },
      },
    });
    await Effect.runPromise(h.runProbeOpEffect("op-ctx", () => Effect.succeed(0)));
    expect(seen?.opId).toBe("op-ctx");
    expect(seen?.sessionId).toBe("s_1");
  });

  it("a span opened in the body nests under the op span THROUGH an awaiting hook", async () => {
    const h = await mkHarness({
      hooks: {
        onBeforeToolProbe: async (input) => {
          await Promise.resolve();
          return input;
        },
      },
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
      hooks: {
        onBeforeToolProbe: async (input) => {
          await Promise.resolve();
          return input;
        },
      },
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
