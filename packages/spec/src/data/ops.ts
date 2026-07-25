/**
 * The ops facet (ADR 19/76/83) — `ctx.run` + `ctx.runner`, the third and
 * fourth rungs of the observability→operation LADDER. Landed FLAT on every
 * ctx surface as a SIBLING of {@link import("./observability.js").Observability}
 * (kept separate so the observability facet stays honest — `run` is not a
 * diagnostic).
 *
 * ## The ladder — climb by how much the system should know about the work
 *
 *   1. **`ctx.metrics.count(...)`** — count it. A tally, no structure.
 *   2. **`ctx.trace(name, fn)`** — see it. A span for timing/attribution;
 *      NO journal, NO hooks, NO guards (a pure annotation inside a handler).
 *   3. **`ctx.run(name, fn)`** — make it a real OPERATION. Runs through the
 *      ambient harness's full `runOperation` pipeline: a journal envelope
 *      (requested → terminal), the inherited interceptor fold (guards + hooks
 *      reach it via the string-keyed generic tier — ad-hoc names are NOT in
 *      the typed `CommandRegistry`), the outcome taxonomy, and a span parented
 *      under the enclosing op. Minted INLINE — no registration.
 *   4. **A registered command** — name it for the SYSTEM. Typed input/output
 *      in `CommandRegistry`, typed `onBefore/After<Command>` hooks, inbox
 *      addressability, wire-grantability. The full ceremony.
 *
 * `ctx.run` is the deliberate rung BETWEEN an untyped annotation and a
 * registered command: a real, journaled, interceptable operation you did not
 * have to declare. The GAP between rung 3 and rung 4 (no registry, no typed
 * hooks, no addressability) is what keeps the ladder honest — see
 * {@link RunOptions} for why the options surface is frozen-small.
 *
 * Prior art: Restate `ctx.run(name, fn)`, Inngest `step.run(name, fn)`.
 *
 * ## Journaled ≠ memoized (read this before assuming replay)
 *
 * `ctx.run` writes a durable OBSERVATIONAL record — name, timing, input,
 * outcome — to the operation journal. It is **NOT** a resumable/replayed
 * checkpoint. Adopters coming from Restate/Inngest will assume `run`
 * memoizes: that on retry a completed step is skipped and its result
 * replayed. **It does not.** Re-invoking `ctx.run` re-executes `fn`. Durable
 * kill/resume rides the store protocols (ADR 49), not this. The journal entry
 * shape (a standard requested/terminal envelope carrying the input) does not
 * PRECLUDE a future replay story, but none is built.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md
 * @see docs/proposals/v2/blueprint/83-interceptor-collapse.md
 */

import type { Effect } from "effect";

import type { Operation } from "./operations.js";
import type { SubstrateError } from "./errors.js";

// ============================================================================
// Options — frozen-small BY DESIGN
// ============================================================================

/**
 * Per-call ENVELOPE data for {@link Ops.run} — deliberately minimal. These
 * are data-about-the-call, NEVER behavior: no middleware, no hooks, no
 * journaling-policy knobs. Behavior comes from the ambient interceptor fold,
 * exactly like every registered operation.
 *
 * **This surface will not grow.** If `ctx.run` accepted the full command
 * suite it would collapse the ladder's fourth rung (registered commands) into
 * the third. If you need more than envelope data — typed hooks, addressability,
 * per-op middleware — you want {@link Ops.runner} (`ctx.runner.runOperation`,
 * the undiluted primitive) or a registered command. Same rationale Inngest /
 * Restate keep `step.run` / `ctx.run` options minimal.
 */
export interface RunOptions {
  /**
   * The operation's serializable input — journaled verbatim in the
   * `requested` envelope's payload (the audit/replay record of what the step
   * was invoked with). Encouraged: the bare `run(name, fn)` form journals
   * only name/timing/outcome; the `{ input }` form additionally captures the
   * input. `fn` receives NO arguments — it captures what it needs from its
   * closure; `input` is the journaled description, not a parameter.
   */
  readonly input?: unknown;
  /**
   * Free-form call-correlation context (requestId, feature flags, …),
   * annotated on the operation's span. Open bag — a new dimension is a new
   * key, never a framework change.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Explicit telemetry attributes for the operation's span (OTel dimensions),
   * merged over {@link metadata} on the span. Use `metadata` for business
   * context, `spanAttributes` for dashboard dimensions.
   */
  readonly spanAttributes?: Readonly<Record<string, unknown>>;
  /**
   * Abort signal — interrupts the operation fiber (structured cancellation
   * tears down the in-flight `fn`). Composes with the enclosing op's own
   * interruption.
   */
  readonly signal?: AbortSignal;
}

// ============================================================================
// The runner escape hatch — a narrowed, run-only view
// ============================================================================

/**
 * The ambient {@link import("../protocol/index.js")} OperationRunner, exposed
 * on ctx as a **run-only view** (ADR 42 dichotomy — the live instance, not a
 * config blob). The escape hatch for when {@link RunOptions} is too small:
 * `ctx.runner.runOperation(op, body)` is the primitive undiluted — tier-4
 * call-scoped middleware included (it composes outermost of the fold), the
 * full `Operation` shape yours to fill.
 *
 * **Run-only by construction.** This view exposes ONLY `runOperation` — NOT
 * the runner's lifecycle or event-emission surface (`makeEvent` / `publish` /
 * `decideFromShape` and any teardown). Handing handler code the raw runner
 * would leak the harness's substrate plumbing; the narrowed view cannot close,
 * reconfigure, or emit arbitrary envelopes on the harness.
 *
 * Effect-native: `runOperation` returns an un-run `Effect`. Yield it from an
 * `fx`/Effect-native handler (tier-4 context preserved), or run it on a
 * captured runtime. For the promise-returning easy path, use {@link Ops.run}.
 */
export interface OperationRunnerView {
  runOperation<I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect.Effect<R, E, never>,
  ): Effect.Effect<R, E | SubstrateError, never>;
}

// ============================================================================
// The facet
// ============================================================================

/**
 * The ops facet — `run` (ad-hoc inline operation) + `runner` (the primitive
 * escape hatch). Landed flat on every ctx surface beside
 * {@link import("./observability.js").Observability}. See the module docblock
 * for the ladder and the journaled≠memoized rule.
 */
export interface Ops {
  /**
   * Mint an ad-hoc OPERATION inline and run `fn` inside it — rung 3 of the
   * ladder. Runs through the ambient harness's full `runOperation` pipeline
   * (journal envelope, the inherited interceptor fold, outcome taxonomy) with
   * a span parented under the enclosing operation. The op name becomes
   * `<surface>:run:<name>` so it is hook-addressable via the string-keyed
   * generic tier (an `onBefore<Surface>Run<Name>` hook on the ambient harness
   * observes it) and distinct from registered `<surface>:command:<verb>` ops.
   *
   * NOT a checkpoint — re-invoking re-runs `fn` (see the module docblock).
   *
   * ```ts
   * const rows = await ctx.run("retrieval", () => db.search(q));            // journaled op
   * const out  = await ctx.run("charge", { input: { amount } }, () => pay(amount)); // + input journaled
   * ```
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  run<T>(name: string, opts: RunOptions, fn: () => T | Promise<T>): Promise<T>;

  /**
   * The ambient operation runner as a run-only view — the escape hatch when
   * {@link RunOptions} is too small. `ctx.run`'s options will not grow; if you
   * need more, you want `ctx.runner` or a registered command.
   */
  readonly runner: OperationRunnerView;
}
