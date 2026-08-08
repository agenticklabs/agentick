/**
 * `deriveOps` (ADR 19/76/83) — turns a harness's bound `runOperation` into
 * the flat {@link Ops} facet (`ctx.run` + `ctx.runner`), the third/fourth
 * rungs of the observability→operation ladder. Sibling of
 * `deriveObservability`; same "N thin ctx assemblers, ONE implementation"
 * pattern.
 *
 * ## `ctx.run` = an ad-hoc operation, minted inline
 *
 * `run(name, fn)` manufactures an {@link Operation} named `<surface>:run:<name>`
 * and drives it through the ambient harness's `runOperation` — so it gets the
 * journal envelope (requested → terminal), the inherited interceptor fold
 * (guards + string-keyed hooks), the outcome taxonomy, and a span parented
 * under the enclosing op. Parenting + `parentOpId` ride the SAME ADR-77
 * FiberRef mechanism `ctx.trace` uses: when a captured operation runtime is
 * supplied, the op runs on it (op span + ambient `RuntimeContext.opId` in its
 * Context → `runOperation` auto-nests and auto-links). Off-fiber surfaces (the
 * MCP request ctx, assembled outside any op) pass no runtime — the op still
 * runs through `runOperation` (journal + interceptors intact) as a ROOT op on
 * the default runtime.
 *
 * **Journaled ≠ memoized** — see the {@link Ops} module docblock. This builds
 * a durable observational record, not a replay checkpoint.
 *
 * @see ./observability.ts — the sibling facet + the captured-runtime rationale
 * @see ./operation-runner.ts — `RunOperation`, the primitive this wraps
 * @verifiedBy packages/tool-executor/src/__tests__/ctx-run.spec.ts
 */

import { Effect, Runtime } from "effect";
import type {
  EventScope,
  EventSurface,
  Operation,
  OperationRunnerView,
  Ops,
  RunOptions,
  SubstrateError,
} from "@agentick/spec";
import { annotateOperationSpan } from "./middleware.js";
import { generateId } from "@agentick/utils";

/** The bound `runOperation` capability (the harness's Tier-2 primitive). */
export type RunOperationFn = <I, R, E>(
  op: Operation<I, R, E>,
  body: (input: I) => Effect.Effect<R, E, never>,
) => Effect.Effect<R, E | SubstrateError, never>;

/** Inputs to {@link deriveOps}. */
export interface DeriveOpsDeps {
  /** The ambient harness's event surface — the `<surface>` in `<surface>:run:<name>`. */
  readonly surface: EventSurface;
  /** The scope stamped on every ad-hoc op (the caller's work-path coordinates). */
  readonly scope: EventScope;
  /** The harness's bound `runOperation` (`this.runOperation`) — journals + interceptor fold. */
  readonly runOperation: RunOperationFn;
  /**
   * The operation runtime captured IN-FIBER (inside the enclosing op body), so
   * `ctx.run` ops parent under it. `undefined` on off-fiber surfaces (MCP
   * request ctx) — the op then runs as a root on the default runtime.
   */
  readonly runtime?: Runtime.Runtime<never>;
}

/** Build the {@link Ops} facet (`run` + `runner`) for one ctx surface. */
export function deriveOps(deps: DeriveOpsDeps): Ops {
  const runPromise =
    deps.runtime !== undefined ? Runtime.runPromise(deps.runtime) : Effect.runPromise;

  function run<T>(
    name: string,
    optsOrFn: RunOptions | (() => T | Promise<T>),
    maybeFn?: () => T | Promise<T>,
  ): Promise<T> {
    const opts: RunOptions = typeof optsOrFn === "function" ? {} : optsOrFn;
    const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => T | Promise<T>;

    const op: Operation<unknown, T, unknown> = {
      opId: generateId(),
      surface: deps.surface,
      name: `${deps.surface}:run:${name}`,
      scope: deps.scope,
      input: opts.input,
    };

    // Body: annotate the op span with metadata + spanAttributes (spanAttributes
    // wins on collision), then run the adopter's fn off-fiber. `runOperation`
    // wraps this in the journal envelope + interceptor fold + op span.
    const body = (): Effect.Effect<T, unknown, never> =>
      Effect.gen(function* () {
        if (opts.metadata !== undefined || opts.spanAttributes !== undefined) {
          yield* annotateOperationSpan({ ...opts.metadata, ...opts.spanAttributes });
        }
        return yield* Effect.tryPromise({
          try: () => Promise.resolve(fn()),
          catch: (e) => e as unknown,
        });
      });

    return runPromise(
      deps.runOperation(op, body),
      opts.signal ? { signal: opts.signal } : undefined,
    );
  }

  const runner: OperationRunnerView = { runOperation: deps.runOperation };
  return { run, runner };
}
