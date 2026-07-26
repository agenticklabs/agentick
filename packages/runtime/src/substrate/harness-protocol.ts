/**
 * Harness protocol bridges — the stateless Effect→JS boundary helpers every
 * concrete harness surface uses to project its Effect-canonical operation bodies
 * onto the Promise / AsyncStream shapes application code consumes.
 *
 * Extracted from `base-harness.ts` (A2.4) as a NEUTRAL leaf module so both
 * {@link BaseHarness} and `command-runner.ts` can import them without a cycle
 * (the runner produces the public command faces, which are exactly these
 * projections). Neither function touches harness state — they are pure bridges
 * over a caller-supplied Effect.
 *
 * @see docs/proposals/v2/blueprint/77-effect-spine.md
 */

import { Cause, Effect, Exit, Fiber, ManagedRuntime, Option, Queue, Runtime } from "effect";
import { unwrapExit } from "@agentick/utils";
import type { AsyncStream } from "@agentick/spec";

/**
 * Run an operation-bearing Effect to a Promise, normalizing the Exit.
 *
 * Concrete harness protocol surfaces (e.g. `CompilerProtocol`,
 * `ToolExecutorProtocol`) keep Promise-typed return shapes for
 * ergonomic application code. This helper closes the gap: the typed
 * `SubstrateError` / `OperationOutcomeError` / body-`E` value at the
 * head of the failure cause becomes the Promise's rejection reason.
 *
 * Defects (interrupts, unhandled throws) reject with a normal `Error`
 * carrying `Cause.pretty(cause)`.
 *
 * Optionally runs on a caller-provided `ManagedRuntime` (ADR 78) instead of
 * the default runtime — this is how the app-/node-scoped telemetry runtime
 * gets its tracer onto the substrate's `Effect.withSpan` annotations. When
 * `runtime` is omitted the behavior is identical to before (default runtime),
 * so every existing call site is unaffected.
 */
export async function runHarnessProtocol<R>(
  eff: Effect.Effect<R, unknown, never>,
  runtime?: ManagedRuntime.ManagedRuntime<never, never>,
): Promise<R> {
  const exit = await (runtime ? runtime.runPromiseExit(eff) : Effect.runPromiseExit(eff));
  return unwrapExit(exit) as R;
}

/**
 * Run an operation-bearing Effect to a Promise **on a CAPTURED FIBER
 * RUNTIME** — the trunk-preserving sibling of {@link runHarnessProtocol}.
 *
 * `runHarnessProtocol`'s default path (`Effect.runPromiseExit`) starts a ROOT
 * fiber that inherits no FiberRef, so an operation run through it becomes an
 * orphaned root: no `parentOpId`, no ambient `RuntimeContext`, and every seam
 * it feeds (a resource resolver, a prompt `render`) sees an identity-free ctx.
 * A `Runtime.Runtime<never>` captured IN-FIBER (`yield* Effect.runtime()`
 * inside an operation body) carries that fiber's FiberRefs, so an Effect run on
 * it inherits the enclosing operation's trunk — its ops nest and its ctx
 * derivations see the real identity.
 *
 * This is the same mechanism `ctx.run` uses (see `deriveOps`); the difference
 * is what gets run: `ctx.run` mints an ad-hoc op around a plain callback, this
 * runs an ALREADY-BUILT operation Effect — a harness's `.fx` twin — from a
 * Promise-shaped boundary that sits inside the op (an SDK request handler).
 *
 * The Exit is normalized exactly as in {@link runHarnessProtocol}, so the
 * rejection reason is the body's own typed error and error identity survives
 * the crossing (`instanceof` / `_tag` checks downstream still hold).
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md §Slice A
 */
export async function runHarnessProtocolOn<R>(
  runtime: Runtime.Runtime<never>,
  eff: Effect.Effect<R, unknown, never>,
): Promise<R> {
  const exit = await Runtime.runPromiseExit(runtime)(eff);
  return unwrapExit(exit) as R;
}

/**
 * Bridge a streaming operation's Effect-canonical form to the JS
 * {@link AsyncStream} facade — the streaming sibling of
 * {@link runHarnessProtocol}, and the singular concept behind EVERY
 * streaming edge (ADR 77).
 *
 * The canonical form is a **sink-fold**: `build(sink)` returns the Effect
 * that drives the work once, invoking `sink(item)` per emitted item and
 * succeeding with the final `Result`. In-process Effect callers compose
 * that Effect directly (one fiber, no bridge). This helper adds the
 * JS-shaped projection on top: it runs the Effect on a daemon fiber, tees
 * items into a bounded queue (real backpressure — a lagging iterator
 * consumer pauses the upstream via `Queue.offer`), and exposes both an
 * `AsyncIterable<Item>` and a `result` Promise reading the same fiber's
 * outcome. All the Queue/fork/Promise machinery lives HERE, once — a new
 * streaming edge supplies only its `build` and a couple of policy hooks.
 *
 * `result` and iteration observe ONE run. The iterator throws a real
 * provider failure (matching async-iterable ecosystem semantics) but
 * completes cleanly on cancellation — `options.isCancellation`
 * distinguishes the two (interrupts always complete cleanly). `abort`
 * interrupts the fiber; `onAbort` runs first for edge-specific bookkeeping.
 * `onStart` hands the running fiber to the edge (e.g. to register it for
 * an out-of-band `abort(id)` path). `runtime` threads a telemetry
 * `ManagedRuntime` the same way `runHarnessProtocol` does.
 */
export function runHarnessStream<Item, Result>(
  build: (sink: (item: Item) => Effect.Effect<void>) => Effect.Effect<Result, unknown, never>,
  options?: {
    readonly queueCapacity?: number;
    readonly isCancellation?: (cause: unknown) => boolean;
    readonly onStart?: (fiber: Fiber.RuntimeFiber<Result, unknown>) => void;
    readonly onAbort?: (reason: string) => void;
    readonly runtime?: ManagedRuntime.ManagedRuntime<never, never>;
  },
): AsyncStream<Item, Result> {
  const capacity = options?.queueCapacity ?? 16;
  const isCancellation = options?.isCancellation ?? ((): boolean => false);
  const run = <A>(eff: Effect.Effect<A, never, never>): Promise<A> =>
    options?.runtime ? options.runtime.runPromise(eff) : Effect.runPromise(eff);

  type QItem = Option.Option<Item>;
  type QF = { queue: Queue.Queue<QItem>; fiber: Fiber.RuntimeFiber<Result, unknown> };

  // Setup runs once; the daemon fiber outlives it so the iterator and
  // `result` can both observe the same outcome. `None` terminates the
  // queue whatever the fiber's exit (success / failure / interrupt).
  const program = Effect.gen(function* () {
    const queue = yield* Queue.bounded<QItem>(capacity);
    const sink = (item: Item): Effect.Effect<void> =>
      Queue.offer(queue, Option.some(item)).pipe(Effect.asVoid);
    const runEffect = build(sink).pipe(Effect.ensuring(Queue.offer(queue, Option.none<Item>())));
    const fiber = yield* Effect.forkDaemon(runEffect);
    return { queue, fiber } satisfies QF;
  });

  let resolveQF!: (v: QF) => void;
  let rejectQF!: (e: unknown) => void;
  const ready = new Promise<QF>((res, rej) => {
    resolveQF = res;
    rejectQF = rej;
  });
  void run(program).then((qf) => {
    resolveQF(qf);
    options?.onStart?.(qf.fiber);
  }, rejectQF);

  const result: Promise<Result> = ready.then(({ fiber }) =>
    run(Fiber.await(fiber)).then((exit) => unwrapExit(exit) as Result),
  );
  // The caller may never await `.result`; don't let Node flag it.
  result.catch(() => {});

  return {
    result,
    abort: (reason) => {
      options?.onAbort?.(reason ?? "aborted");
      void ready.then(({ fiber }) => run(Fiber.interrupt(fiber)));
    },
    [Symbol.asyncIterator](): AsyncIterator<Item> {
      return {
        next: async (): Promise<IteratorResult<Item>> => {
          const { queue, fiber } = await ready;
          const item = await run(Queue.take(queue)).catch(() => Option.none<Item>());
          if (Option.isNone(item)) {
            const exit = await run(Fiber.await(fiber));
            if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
              const cause = Cause.squash(exit.cause);
              if (!isCancellation(cause)) throw cause;
            }
            return { value: undefined as unknown as Item, done: true };
          }
          return { value: item.value, done: false };
        },
        return: async (): Promise<IteratorResult<Item>> => {
          try {
            const { fiber, queue } = await ready;
            await run(Fiber.interrupt(fiber));
            await run(Queue.shutdown(queue));
          } catch {
            // ignore — caller is closing iteration
          }
          return { value: undefined as unknown as Item, done: true };
        },
      };
    },
  };
}
