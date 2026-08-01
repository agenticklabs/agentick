/**
 * Runtime signal family — `log` + `progress` firewall types (ADR 64).
 *
 * Signals are **out-of-band diagnostics + liveness**, orthogonal to
 * model-IR content. A component (a tool via `ctx.log` / `ctx.progress`,
 * or any harness via the shared `BaseHarness` emit helpers) produces
 * ONE structured event on the bus; it is NOT sent to any wire directly.
 * Projections subscribe: the MCP-server projection forwards to
 * `notifications/message` + `notifications/progress`; the agentick
 * client receives via the existing subscribe / progress infra.
 *
 * **Emit once (framework), receive everywhere (MCP + app).**
 *
 * These are firewall types — they cross the wire to the client, so they
 * live in `@agentick/spec` (the shared vocabulary), NOT in any
 * harness package.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import type { EventQuery } from "./events.js";

// ============================================================================
// Level + token wire types
// ============================================================================

/**
 * Syslog-derived severity levels, ordered least→most severe. Mirrors
 * the MCP wire `logging/setLevel` + `notifications/message` `level`
 * enum, but is a framework-general type — every surface's `ctx.log`
 * uses it, not just MCP. `McpLogLevel` is a re-export alias of this
 * (one source of truth).
 */
export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/**
 * Progress correlation token. Matches the MCP wire type
 * (`notifications/progress` `progressToken`): a string or number chosen
 * by the caller that ties a stream of progress updates to one logical
 * operation.
 */
export type ProgressToken = string | number;

// ============================================================================
// Event payloads
// ============================================================================

/**
 * Payload of a `log` signal event. Rides the bus event envelope's
 * `payload` field under the canonical `<surface>:signal:log` name.
 *
 * - `level`   — syslog severity; projections apply their own threshold.
 * - `data`    — arbitrary JSON-serializable diagnostic payload.
 * - `logger`  — optional logical channel name (the MCP wire `logger`).
 * - `traceId` — active trace id when a span was in scope at emission
 *   (ADR 64/78 correlation). The join between a bus-log and its
 *   provider-trace: a subscriber (or an OTel-log bridge) reads these to
 *   land the log line on the same trace as its span. Absent when telemetry
 *   is off or no span was active. Wire projections that don't carry trace
 *   context (MCP `notifications/message`) simply ignore these fields.
 * - `spanId`  — active span id, paired with `traceId`.
 */
export interface LogEventPayload {
  readonly level: LogLevel;
  readonly data: unknown;
  readonly logger?: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

/**
 * ONE progress frame, minus the correlation token — the grammar every
 * progress-producing surface in the framework speaks. The `progress` signal
 * family adds a {@link ProgressToken} to it ({@link ProgressEventPayload});
 * a task's progress stream keys it by the task's own id. Same three fields,
 * same rules, so a UI folding one can fold the other.
 *
 * - `progress` — monotonic progress amount so far.
 * - `total`    — optional upper bound; absent for indeterminate work.
 * - `message`  — optional human-readable status.
 *
 * ## The four laws
 *
 * Byte-identical to MCP's `notifications/progress` params, and governed by
 * four rules every emitter upholds and every receiver may rely on.
 * {@link createProgressReporter} enforces all four by construction; a
 * receiver folding frames from an emitter it does NOT control (a third-party
 * MCP server) still validates them.
 *
 * 1. **Frame-classifiability.** Every frame classifies ALONE: `total`
 *    present = determinate (render a bar at `progress / total`), `total`
 *    absent = indeterminate (render a spinner). No stream state is needed to
 *    decide, which is precisely what lets a LATE JOINER — a reconnecting
 *    client, a snapshot splice, a UI mounted mid-flight — render correctly
 *    from the first frame it happens to see. A determinate frame that omits
 *    `total` because "an earlier frame carried it" breaks every late joiner
 *    and is a bug in the emitter.
 * 2. **One-way ratchet.** A token may go indeterminate → determinate ONCE,
 *    when the denominator is learned mid-flight (a `content-length` that only
 *    arrives with the response headers). It never goes back, and once set,
 *    `total` never changes to a different value. A shrinking or vanishing
 *    `total` is not a legal update.
 * 3. **Monotonic.** `progress` never decreases for a given token.
 * 4. **Terminal by operation, not by frame.** There is deliberately NO `done`
 *    field. The owning operation's lifecycle closes the bar — the tool call
 *    resolves, the task reaches a terminal {@link
 *    import("../protocol/tasks-harness.js").TaskStatus}. Keeping the frame
 *    free of a terminal flag is what keeps it byte-identical to the MCP wire
 *    shape in both directions; a UI that wants "hold at 99% until the
 *    operation settles" implements that policy itself, from the lifecycle it
 *    is already watching.
 *
 * @verifiedBy packages/spec/src/__tests__/progress-reporter.spec.ts
 */
export interface ProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

/**
 * Payload of a `progress` signal event — one {@link ProgressUpdate} plus its
 * correlation token. Rides the bus event envelope's `payload` field under the
 * canonical `<surface>:signal:progress` name, and is byte-identical to MCP's
 * `notifications/progress` params in both directions.
 *
 * `token` is echoed onto the wire `progressToken`. The four laws governing the
 * other three fields are on {@link ProgressUpdate}.
 */
export interface ProgressEventPayload extends ProgressUpdate {
  readonly token: ProgressToken;
}

// ============================================================================
// ProgressReporter — the four laws, by construction
// ============================================================================

/** The single-emission primitive a {@link ProgressReporter} wraps — one frame per call. */
export type ProgressEmit = (update: ProgressUpdate) => void;

/** Opening state for {@link createProgressReporter} / {@link ProgressBegin.begin}. */
export interface ProgressReporterOptions {
  /** The denominator, when known up front. Omit for indeterminate work — never fake one. */
  readonly total?: number;
  /** Status carried on the opening frame. */
  readonly message?: string;
}

/**
 * A progress reporter for ONE operation — a stateful counter that upholds the
 * four laws on {@link ProgressUpdate} so callers cannot violate them by
 * accident. The token is baked in by whatever minted the reporter
 * ({@link ProgressBegin.begin}), so a caller never invents one.
 *
 * ```ts
 * const p = ctx.progress.begin({ total: files.length, message: "indexing" });
 * for (const f of files) p.advance(1, f.name);
 * p.done("indexed");
 * ```
 *
 * **Opening frame.** Construction emits ONE frame immediately — `progress: 0`,
 * carrying `total` when known — so a UI shows the affordance (bar or spinner)
 * the moment the work starts, rather than at the first `advance()`. Work that
 * may emit nothing else still announces that it began.
 *
 * **Input discipline.** `advance` / `set` / `note` / `done` NEVER throw: a
 * non-finite or negative input is clamped or ignored, because a bad number in
 * a progress call must not take down the work the progress is describing.
 * {@link total} is the sole exception — it throws on a ratchet violation,
 * which is a programming error, not a data glitch.
 *
 * TODO(progress-composition): weighted child composition — `reporter.child(weight)`,
 * minting a sub-reporter that owns a slice of this one's range so a fan-out
 * (N parallel sub-jobs) reports ONE coherent bar instead of N competing tokens.
 * Deliberately unbuilt: the grammar already accommodates it (a child folding
 * into the parent's count needs no new frame fields), and there is no second
 * consumer yet. Build it when one appears, not before.
 *
 * @verifiedBy packages/spec/src/__tests__/progress-reporter.spec.ts
 */
export interface ProgressReporter {
  /**
   * Add `n` (default `1`) to the count and emit a frame. Monotonic by
   * construction — a negative or non-finite `n` contributes nothing. Clamps to
   * `total` once known.
   */
  advance(n?: number, message?: string): void;
  /**
   * Move the count to the absolute value `current` and emit a frame. A value
   * below the current count (or a non-finite one) does NOT move the bar — the
   * frame still emits, carrying `message`, at the unchanged count. Clamps to
   * `total` once known.
   */
  set(current: number, message?: string): void;
  /** Emit a message-only frame: the current count, restated, with new text. */
  note(message: string): void;
  /**
   * The one-way ratchet — learn the denominator mid-flight, turning a spinner
   * into a bar. Emits one frame immediately so the upgrade is visible without
   * waiting for the next `advance()`.
   *
   * **Throws** when `n` is not a positive finite number, or when a total is
   * already set (law 2: once set, never changed). Set it via
   * {@link ProgressReporterOptions.total} when it is known up front.
   */
  total(n: number): void;
  /**
   * Emit the final frame — at `total` when known, at the current count
   * otherwise. Idempotent: a second `done()`, and ANY emission after the
   * first, are dropped. Note that `done()` is a reporter-side convenience for
   * "fill the bar"; per law 4 it puts nothing on the wire that says terminal —
   * the owning operation's lifecycle is what closes the bar.
   */
  done(message?: string): void;
}

/**
 * Build a {@link ProgressReporter} over a raw {@link ProgressEmit}. The single
 * constructor for the reporter — used by every surface that mints one
 * (`ctx.progress.begin` in the tool executor, `ctx.progress.begin` in a task
 * work body) and by adopters wrapping their own emitter. Pure: it owns the
 * count, the ratchet, and the finished flag; the emitter owns the token,
 * scoping, and delivery.
 *
 * @verifiedBy packages/spec/src/__tests__/progress-reporter.spec.ts
 */
export function createProgressReporter(
  emit: ProgressEmit,
  opts?: ProgressReporterOptions,
): ProgressReporter {
  let count = 0;
  let total = isPositiveFinite(opts?.total) ? opts.total : undefined;
  let finished = false;

  // Law 1 — every frame carries `total` when it is known, so each classifies
  // alone. Law 4 — no terminal flag ever reaches the frame.
  const emitFrame = (message?: string): void => {
    if (finished) return;
    emit({
      progress: count,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  };

  const moveTo = (next: number): void => {
    if (!Number.isFinite(next) || next < count) return; // law 3
    count = total !== undefined ? Math.min(next, total) : next;
  };

  // The opening frame: the affordance appears when the work starts.
  emitFrame(opts?.message);

  return {
    advance(n = 1, message) {
      moveTo(count + (Number.isFinite(n) && n > 0 ? n : 0));
      emitFrame(message);
    },
    set(current, message) {
      moveTo(current);
      emitFrame(message);
    },
    note(message) {
      emitFrame(message);
    },
    total(n) {
      if (!isPositiveFinite(n)) {
        throw new RangeError(`progress total must be a positive finite number, got ${String(n)}`);
      }
      if (total !== undefined) {
        throw new RangeError(
          `progress total is already ${total} — the ratchet is one-way (law 2); it cannot be changed to ${n}`,
        );
      }
      total = n;
      count = Math.min(count, n);
      emitFrame();
    },
    done(message) {
      if (finished) return;
      if (total !== undefined) count = total;
      emitFrame(message);
      finished = true;
    },
  };
}

function isPositiveFinite(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

// ============================================================================
// The handler-facing progress surfaces (callable object — ADR 64, cf. `Log`)
// ============================================================================

/**
 * The half of the progress surface that MINTS reporters. Carried alone by
 * surfaces whose token is fixed and implicit — a task work body, where the
 * token is the task's own id, so there is nothing to correlate by hand.
 */
export interface ProgressBegin {
  /**
   * Start reporting progress for this operation. The token is supplied by the
   * surface. Emits the opening frame immediately — see {@link ProgressReporter}.
   */
  begin(opts?: ProgressReporterOptions): ProgressReporter;
}

/**
 * The full progress surface — a CALLABLE OBJECT, exactly like {@link
 * import("./observability.js").Log}. The call form is the RAW DOOR: an
 * explicit token plus a hand-built frame, kept for bridging a token that came
 * from somewhere else (an MCP client's `_meta.progressToken`) and for exotic
 * emitters that own their own counting. {@link ProgressBegin.begin} is the
 * everyday door — it mints the token and upholds the four laws.
 */
export interface Progress extends ProgressBegin {
  (token: ProgressToken, update: ProgressUpdate): void;
}

/** The raw two-argument emission a {@link Progress} wraps. */
export type ProgressRawEmit = (token: ProgressToken, update: ProgressUpdate) => void;

/**
 * Build a {@link ProgressBegin} over a raw {@link ProgressEmit} whose token is
 * already bound — the shape a task work body gets.
 */
export function createProgressBegin(emit: ProgressEmit): ProgressBegin {
  return { begin: (opts) => createProgressReporter(emit, opts) };
}

/**
 * Build a {@link Progress} callable object around a raw {@link ProgressRawEmit}.
 * `token` is the surface's own correlation id (the tool call id, for the tool
 * executor) — what `begin()` bakes into the reporters it mints. Mirrors
 * {@link import("./observability.js").createLog}: one constructor, and the
 * sugar collapses to the same single emission the call form makes.
 *
 * @verifiedBy packages/tool-executor/src/__tests__/signals.spec.ts
 */
export function createProgress(emit: ProgressRawEmit, token: ProgressToken): Progress {
  const progress = ((t: ProgressToken, update: ProgressUpdate) => emit(t, update)) as Progress;
  progress.begin = (opts) => createProgressReporter((update) => emit(token, update), opts);
  return progress;
}

// ============================================================================
// Canonical name domain — `<surface>:signal:<action>`
// ============================================================================

/**
 * Event-name domain for the signal family. Signal event names are
 * `<surface>:signal:log` / `<surface>:signal:progress` — the middle
 * segment is always `"signal"`, distinguishing diagnostics from
 * operation-lifecycle (`command`), channel (`channel`), and other
 * domains.
 */
export const SIGNAL_NAME_DOMAIN = "signal" as const;

/** Canonical `log` signal event name for a given emitting surface. */
export function logEventName(surface: string): string {
  return `${surface}:${SIGNAL_NAME_DOMAIN}:log`;
}

/** Canonical `progress` signal event name for a given emitting surface. */
export function progressEventName(surface: string): string {
  return `${surface}:${SIGNAL_NAME_DOMAIN}:progress`;
}

/**
 * Subscriber-side query matching `log` signal events across ALL
 * surfaces. Uses the `wildcard` {@link NameQuery} mode — `"*"` matches
 * exactly one segment — so `*:signal:log` matches `tool:signal:log`,
 * `mcp:signal:log`, `session:signal:log`, … regardless of the emitting
 * surface. Combine with a `scope` filter (e.g. `{ sessionId }` or
 * `{ mcpConnectionId }`) to narrow to one connection / session.
 *
 * @verifiedBy packages/spec/src/__tests__/signals.spec.ts
 */
export function logEventQuery(): EventQuery {
  return { name: { wildcard: `*:${SIGNAL_NAME_DOMAIN}:log` } };
}

/**
 * Subscriber-side query matching `progress` signal events across ALL
 * surfaces. See {@link logEventQuery} for the wildcard semantics.
 *
 * @verifiedBy packages/spec/src/__tests__/signals.spec.ts
 */
export function progressEventQuery(): EventQuery {
  return { name: { wildcard: `*:${SIGNAL_NAME_DOMAIN}:progress` } };
}

/**
 * Is this event name a `progress` signal from ANY surface? The PREDICATE form
 * of {@link progressEventQuery}, for a consumer holding a delivered envelope
 * rather than opening a subscription — the client stitching a mixed progress
 * stream is the canonical one (`@agentick/client-core`'s `events()`, which
 * must tell a signal frame from an execution-event frame).
 *
 * Matches the wildcard exactly, not loosely: `*` is ONE segment, so a name is
 * a progress signal iff it has three segments and the last two are
 * `signal:progress`. `endsWith` would wrongly admit `a:b:signal:progress`.
 *
 * @verifiedBy packages/spec/src/__tests__/signals.spec.ts
 */
export function isProgressEventName(name: string): boolean {
  const segments = name.split(":");
  return segments.length === 3 && segments[1] === SIGNAL_NAME_DOMAIN && segments[2] === "progress";
}
