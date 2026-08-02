/**
 * TimelineHarness — append-only log + materialized projection.
 *
 * Implements {@link TimelineHarnessProtocol}. Extends `BaseHarness<"timeline">`
 * so writes participate in the substrate's Operation contract.
 *
 * **Two-tier storage:**
 *
 *   - `persisted` — the durable, append-only log. Only `append` mutates
 *     it; once an entry lands, the harness will never remove or modify
 *     it. The session's source of truth for "what happened."
 *   - `projection` — what `read()`/`subscribe()` expose. Normally a
 *     live mirror of `persisted`; after `compact` or `replaceProjection`,
 *     can diverge. Subsequent appends land at the tail of the projection
 *     too — the natural "compacted prefix + recent" shape.
 *
 * **Invocation (ADR 51)** — every verb is a DECLARED COMMAND
 * (constructor, `this.command()`): `timeline:append`, `timeline:replaceProjection`,
 * `timeline:resetProjection`, `timeline:compact` (the **signal form**), and
 * `timeline:history` (the cursored READ — ADR 93's client scroll-back door). One
 * canonical string per verb is simultaneously the inbox message type over
 * `timeline:{scopeId}`, the op-name root, the authz scope label, and the
 * (matrix-gated) wire method name.
 *
 * `compact` crosses boundaries as a bare verb + optional advisory
 * `instructions` (serializable data) resolved against the
 * construction-bound default strategy (`TimelineHarnessOptions.compact`
 * / `withTimeline({ compact })`). The strategy itself — executable
 * configuration — never travels; the explicit-arg `compact(strategy)`
 * form is an in-process-only override and stays a hand-built Operation
 * by doctrine (ADR 51 §1.2).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { mergeLayered, omitUndefined } from "@agentick/utils";

import { Effect } from "effect";
import {
  BaseHarness,
  qualifyNamespaceGuards,
  qualifyNamespaceHooks,
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
  type Unsubscribe,
} from "@agentick/runtime";
import { LogView } from "@agentick/store";

import { MemoryTimelineStore } from "./store.js";
import { hydrateFromStore } from "./hydrators.js";
import type {
  TimelineCompactCtx,
  TimelineCompactor,
  TimelineDefinition,
  TimelineHydrateCtx,
  TimelineHydrator,
} from "./definition.js";
import type {
  TimelineHarnessFx,
  SubstrateError,
  CompactResult,
  CompactStrategy,
  ContentBlock,
  CostRollup,
  EventBus,
  JournalingPolicy,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  ModelUsage,
  Operation,
  OperationJournal,
  OperationOrigin,
  SeqTagged,
  StopCause,
  StandardSchemaV1,
  TimelineAppendInput,
  TimelineEntry,
  TimelineHarnessProtocol,
  TimelineStore,
  TimelineHarnessSnapshot,
  TimelineImportSnapshotOptions,
  TimelineReplaceProjectionInput,
  TimelineSnapshot,
  MessageTimelineEntry,
  TurnBoundaryEntry,
  UsageStats,
} from "@agentick/spec";
import {
  CompactHandlerFailed,
  CompactStrategyMissing,
  DEFAULT_JOURNALING_POLICY,
  HandlerError,
  TimelineHydrateFailed,
  TimelineWriteFailed,
} from "@agentick/spec";

import type { TimelineHistoryInput, TimelineHistoryPage } from "./wire-augment.js";

// ADR 80/83 — light up the compaction verb. `timeline:compact` is a DECLARED
// command (`compactCmd`, the signal form) routed through `runOperation`, so
// typing it here mints `onBeforeTimelineCompact` / `onAfterTimelineCompact` on
// the derived `CommandHooks` surface. Input is the wire-safe compact SIGNAL
// (the `compactCmd` generic — the resident strategy never travels); output the
// `CompactResult`. The in-process-only explicit-arg `compact(strategy)` form
// shares the op name, so its hooks fire too; the signal input is the widest
// type both carry on the registry key.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "timeline:append": { input: TimelineAppendInput; output: void };
    "timeline:replaceProjection": { input: TimelineReplaceProjectionInput; output: void };
    "timeline:resetProjection": { input: undefined; output: void };
    "timeline:compact": {
      input: { readonly instructions?: string | readonly unknown[] };
      output: CompactResult;
    };
    "timeline:history": { input: TimelineHistoryInput; output: TimelineHistoryPage };
  }
}

/**
 * Journaling for the timeline surface: the substrate default, plus the READ
 * class.
 *
 * `timeline:history` is a READ — it changes nothing, so there is nothing to
 * recover or audit-replay from a durable record of it. Journaling reads would
 * grow the recovery spine without ever being read back, and a client paging
 * scroll-back does it a page at a time. So the read is **bus-only**: still
 * observable live (metrics, tracing, an audit subscriber that wants to see who
 * read what), never durable. Writes (`append` / `compact` /
 * `replaceProjection`) keep the default `requested` + `terminal` journaling.
 *
 * An adopter-supplied `policy` layers ON TOP (per-key), so this is a default and
 * not a mandate.
 */
const TIMELINE_JOURNALING: Readonly<Record<string, "always" | "bus-only" | "drop">> = {
  "timeline:command:history": "bus-only",
};

// TODO(D-phase): a read's terminal envelope carries its RESULT, so a large
// scroll-back page is published to the session bus (journaling is already off).
// It is scope-confined — only that session's subscribers see it — but it is pure
// noise. The fix is a per-op result projection at the terminal (publish a size
// summary for reads), which belongs in the operation runner, not here.
//
// TODO(D-phase): `ctx.principal` is undefined inside this namespace's guards —
// `buildSessionBridges` (@agentick/session) does not thread the session's
// principal into any bridge harness, so `deriveOperationCtx`/`makeEvent` have
// nothing to stamp (see `hydrateCtx`, which already reads `this.principal` for
// the genesis seam). Cross-principal admission is the wire choke point's and is
// unaffected; this only bounds how narrow a namespace-local guard can be.

/** A declared command's public invoker (ADR 51). */
type Cmd<I, R> = (input: I, opts?: { readonly origin?: OperationOrigin }) => Promise<R>;

/**
 * Construction options for {@link TimelineHarness} — the {@link
 * TimelineDefinition} (ADR 93: *the definition IS the options*) plus the
 * substrate slots every harness takes ({@link BaseHarnessOptions}: inherited
 * interceptors, telemetry, metadata).
 *
 * There is exactly ONE adopter-facing shape. `defineTimeline({...})`,
 * `withTimeline({...})`, `createApp({ timeline })`, and this constructor all
 * consume the same definition; the only thing the constructor adds is what the
 * runtime — never the adopter — supplies.
 */
export interface TimelineHarnessOptions extends BaseHarnessOptions, TimelineDefinition {}

/**
 * Payload schema for the `timeline:compact` **signal form** (ADR 51):
 * a bare verb with optional advisory `instructions`. The resident
 * default strategy is authoritative to honor or ignore them; the
 * strategy itself never travels.
 */
const compactSignalSchema: StandardSchemaV1<{
  readonly instructions?: string | readonly unknown[];
}> = {
  "~standard": {
    version: 1,
    vendor: "@agentick/timeline",
    validate: (value) => {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== "object") {
        return { issues: [{ message: "compact signal payload must be an object" }] };
      }
      const instructions = (value as { instructions?: unknown }).instructions;
      if (
        instructions !== undefined &&
        typeof instructions !== "string" &&
        !Array.isArray(instructions)
      ) {
        return {
          issues: [{ message: "instructions must be a string or an array of content blocks" }],
        };
      }
      return { value: value as { instructions?: string | readonly unknown[] } };
    },
  },
};

/**
 * Payload schema for `timeline:history` — the cursored page request.
 *
 * NORMALIZING as well as validating: it returns ONLY the seq window (`fromSeq` /
 * `toSeq` / `limit`), so the addressing key the dynamic wire lane passes through
 * (`sessionId`) and any other extra never reach the body. The harness reads its
 * OWN scopeId; a caller-supplied session id must not be able to steer the read
 * (the address already selected the session, and the target rule already gated
 * it).
 */
const historyRequestSchema: StandardSchemaV1<TimelineHistoryInput> = {
  "~standard": {
    version: 1,
    vendor: "@agentick/timeline",
    validate: (value) => {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== "object") {
        return { issues: [{ message: "history payload must be an object" }] };
      }
      const { fromSeq, toSeq, limit } = value as {
        fromSeq?: unknown;
        toSeq?: unknown;
        limit?: unknown;
      };
      const issues: Array<{ message: string }> = [];
      const bound = (name: string, v: unknown): void => {
        if (v !== undefined && !(Number.isSafeInteger(v) && (v as number) >= 0)) {
          issues.push({ message: `${name} must be a non-negative integer` });
        }
      };
      bound("fromSeq", fromSeq);
      bound("toSeq", toSeq);
      bound("limit", limit);
      if (issues.length > 0) return { issues };
      return {
        value: omitUndefined({
          fromSeq: fromSeq as number | undefined,
          toSeq: toSeq as number | undefined,
          limit: limit as number | undefined,
        }),
      };
    },
  },
};

export class TimelineHarness extends BaseHarness<"timeline"> implements TimelineHarnessProtocol {
  // ─── Storage (the LOG-archetype projection: two tiers + versions +
  // snapshot cache + render pings + the write-behind pump — ADR 49) ───
  //
  // The whole two-tier / write-behind / compaction-target machine lives in
  // `LogView<TimelineEntry>` (`@agentick/store`); this harness holds only
  // its DOMAIN logic (turn boundaries, compaction STRATEGIES, the declared
  // commands) and delegates every storage touch to `log`.
  private readonly log: LogView<TimelineEntry>;

  // ─── Durable backing (ADR 49) ───
  /** Append-only durable store for the persisted tier; keyed by scopeId (= sessionId). */
  private readonly store: TimelineStore;
  /** Emit turn-boundary records (ADR 53). Default true. */
  private readonly turnBoundaries: boolean;
  private readonly writePolicy: "behind" | "through";
  /**
   * Construction-bound default compaction (ADR 51 signal form), in whichever
   * arm of the dichotomy the definition supplied: a configured
   * {@link CompactStrategy} value, or the `(entries, ctx)` function sugar. At
   * most one is set; {@link defaultStrategy} collapses them to the one shape the
   * body consumes.
   */
  private readonly compactStrategy?: CompactStrategy;
  private readonly compactor?: TimelineCompactor;
  /**
   * The genesis seam (ADR 93) — resolved at construction from the definition's
   * `hydrate` slot, defaulting to {@link hydrateFromStore} whenever a `store`
   * was configured (ADR 49 open-or-rehydrate, preserved exactly). `undefined`
   * means "no genesis": a store-less harness starts empty, which is what the
   * bundled in-memory default has always done.
   */
  private readonly hydrator?: TimelineHydrator;

  // ─── Declared commands (ADR 51) — assigned in the constructor ───
  private readonly appendCmd: Cmd<TimelineAppendInput, void>;
  private readonly replaceProjectionCmd: Cmd<TimelineReplaceProjectionInput, void>;
  private readonly resetProjectionCmd: Cmd<undefined, void>;
  private readonly compactCmd: Cmd<
    { readonly instructions?: string | readonly unknown[] },
    CompactResult
  >;
  private readonly historyCmd: Cmd<TimelineHistoryInput, TimelineHistoryPage>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: TimelineHarnessOptions = {},
  ) {
    super("timeline", scopeId, journal, bus, inbox, {
      ...options,
      // The read class (bus-only history) is a DEFAULT: an adopter `policy`
      // layers over it per-key rather than being replaced by it.
      policy: mergeLayered<JournalingPolicy>(
        DEFAULT_JOURNALING_POLICY,
        { override: TIMELINE_JOURNALING },
        options.policy,
      ),
    });
    this.store = options.store ?? new MemoryTimelineStore();
    this.turnBoundaries = options?.turnBoundaries ?? true;
    this.writePolicy = options.writePolicy ?? "behind";
    // The `compact` slot takes either form of the ADR-42 dichotomy: a
    // `(entries, ctx)` function (declarative shorthand) or a configured
    // `CompactStrategy` value (`fromHandler(...)`, an adopter factory).
    this.compactStrategy = typeof options.compact === "function" ? undefined : options.compact;
    this.compactor = typeof options.compact === "function" ? options.compact : undefined;
    // Genesis (ADR 93): the definition's hydrator, defaulting to the full
    // store read whenever durability is configured. Resolved — not RUN — here:
    // definitions are inert until install and genesis runs at session-open.
    this.hydrator =
      (options.hydrate as TimelineHydrator | undefined) ??
      (options.store !== undefined ? hydrateFromStore() : undefined);
    // The two-tier / write-behind / compaction-target storage machine — keyed
    // by scopeId (= sessionId). The pump's raw store-write rejection is mapped
    // to the typed `TimelineWriteFailed` a session barrier catchTags (write-
    // through: `append` rejects; write-behind: `flush()` throws).
    this.log = new LogView<TimelineEntry>({
      store: this.store,
      logKey: this.scopeId,
      writePolicy: this.writePolicy,
      wrapWriteError: (cause) => new TimelineWriteFailed({ cause }),
    });
    // Drain buffered write-behind entries before the harness tears down —
    // ADR 49: session close() awaits the flush barrier.
    this.onClose(() => this.log.flush());

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming, enumeration, and
    // (future, matrix-gated) wire methods all derive from these; the
    // pre-registry `handleMessage` switch is gone. Payload shapes are
    // unchanged (zero wire-shape change). Payloads carried no
    // validation before the registry; schemas stay off for parity —
    // EXCEPT the new compact signal form, a new surface that validates.
    // NO scope factory. `parentScope` (declared at construction, gap-filled by
    // `makeEvent`) carries the owning session; a command that adds no dims of its
    // own declares nothing.
    this.appendCmd = this.command({
      name: "timeline:append",
      handler: (i: TimelineAppendInput) => this.appendBody(i),
    });
    this.replaceProjectionCmd = this.command({
      name: "timeline:replaceProjection",
      handler: (i: TimelineReplaceProjectionInput) => this.replaceProjectionBody(i),
    });
    this.resetProjectionCmd = this.command({
      name: "timeline:resetProjection",
      handler: () => this.resetProjectionBody(),
    });
    // The ADR 51 signal form: a bare `timeline:compact` verb — from the
    // inbox, another node, or (matrix-gated) the wire — runs the
    // construction-bound default strategy. Optional advisory
    // `instructions` ride as data; the resident strategy is
    // authoritative to honor or ignore them. The strategy itself never
    // travels (the explicit-arg `compact(strategy)` stays an
    // in-process-only hand-built operation by doctrine).
    this.compactCmd = this.command({
      name: "timeline:compact",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      input: compactSignalSchema,
      handler: (signal) =>
        Effect.gen(this, function* () {
          const base = this.defaultStrategy();
          if (base === undefined) {
            return yield* Effect.fail(new CompactStrategyMissing());
          }
          const effective: CompactStrategy =
            signal.instructions !== undefined
              ? { ...base, instructions: signal.instructions as CompactStrategy["instructions"] }
              : base;
          return yield* this.compactBody(effective);
        }),
    });
    // The client READ door (ADR 93 §"The client read doors"): a standard read is
    // a wire-exposable command, not a bespoke gateway method. Payload is two
    // scalars, result is a seq-cursored page — fully serializable, so the verb is
    // addressable from the inbox, another node, or (grant-gated) a wire client.
    // Deny-by-default is the existing mechanism, unchanged: the dynamic lane
    // treats a non-`wire` verb as an absent method, an exposed verb still needs a
    // grant on `timeline:history`, and the same-principal target rule scopes it
    // to the addressed session's owner.
    this.historyCmd = this.command({
      name: "timeline:history",
      exposure: "wire",
      input: historyRequestSchema,
      description: "Read a cursored page of the durable timeline log",
      handler: (input) =>
        Effect.tryPromise({
          try: () => this.historyPage(input),
          // The store-lacks-`history` failure is a configuration fact, not a
          // defect: surface it as a clean operation failure so the caller (and
          // the wire edge) sees the message rather than a fiber death.
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
    });

    // ─── The definition's `hooks:` / `guards:` bags (ADR 93) ───
    //
    // DROP-LAYER keys (`onBeforeAppend`, `guards: { append }`) requalify onto
    // the discriminated commands (`onBeforeTimelineAppend`, `TimelineAppend`)
    // and register on this harness's OWN chain — deliberately NARROWER than the
    // `inheritedInterceptors` an app/session hands down. That is the cascade
    // law: broader scope wraps narrower, so app before-hooks run first and app
    // guards veto before a definition guard is consulted (the runner's stable
    // guard-outermost sort preserves tier order within the guard kind).
    if (options.hooks !== undefined) {
      this.hook(qualifyNamespaceHooks("timeline", options.hooks as Record<string, unknown>));
    }
    if (options.guards !== undefined) {
      this.guard(qualifyNamespaceGuards("timeline", options.guards as Record<string, unknown>));
    }
  }

  /**
   * Collapse the `compact` slot's two dichotomy arms to the ONE shape the body
   * consumes: a resident {@link CompactStrategy}. Returns `undefined` when no
   * default was configured — the no-arg signal form then fails with
   * `CompactStrategyMissing`, which is the contract.
   */
  private defaultStrategy(): CompactStrategy | undefined {
    if (this.compactStrategy !== undefined) return this.compactStrategy;
    const fn = this.compactor;
    if (fn === undefined) return undefined;
    // Adapt the `(entries, ctx)` sugar to the resident `CompactStrategy` shape.
    // `source: "persisted"` matches `fromHandler`'s default — the fold input is
    // the durable log. The ctx is derived PER CALL so the compactor sees the
    // invoking op's identity + diagnostics, and the signal form's advisory
    // `instructions` ride on it.
    return {
      source: "persisted",
      run: async ({ entries, instructions }) => fn(entries, this.compactCtx(instructions)),
    };
  }

  /**
   * Derive the ctx handed to the `compact(entries, ctx)` definition sugar — the
   * op's identity + facets, with the ADR-51 signal form's advisory
   * `instructions` composed in as a boundary extra (branded in one mint, ADR 91
   * §Phase-2, so the lazy facet getters survive).
   */
  private compactCtx(instructions?: string | readonly ContentBlock[]): TimelineCompactCtx {
    return this.deriveOperationCtx(
      // NOT AN EVENT SCOPE — the STORE KEY, and the key IS the
      // composed `scopeId` (`LogView({ logKey: this.scopeId })`). Same field name,
      // different concept; see the note on `hydrateCtx`.
      { sessionId: this.scopeId, op: "TimelineCompact" },
      omitUndefined({ instructions }),
    ) as TimelineCompactCtx;
  }

  /**
   * Derive the ctx handed to the definition's genesis hydrator (ADR 91/93).
   *
   * Minted through `deriveOperationCtx` — the branded boundary constructor — so
   * the hydrator sees the session's identity (`sessionId`, `principal`) and
   * diagnostics (`log`/`trace`/`metrics`/`run`) rather than nothing, plus two
   * boundary facets composed INTO the same branded mint: the definition's
   * `store` (the typed `ctx.store` facet) and the journal's READ slice
   * (`journalReader`), which is what makes an event-sourced hydrator — a fold
   * over the journal — writable with no framework change.
   *
   * The result is also a valid {@link StoreCtx}, so `hydrateFromStore` hands
   * `ctx` straight to `store.read(key, ctx)` with no repacking.
   */
  private hydrateCtx(): TimelineHydrateCtx {
    return this.deriveOperationCtx(
      // NOT AN EVENT SCOPE. `hydrateFromStore` reads this as the LOG KEY —
      // `store.read(ctx.sessionId ?? "", ctx)` — and the log key is the composed
      // `scopeId` the `LogView` was built with, so the composed value is correct
      // here and only here. `StoreCtx` calling its key `sessionId` is why a sweep
      // that deleted `sessionId: this.scopeId` on sight silently emptied genesis.
      //
      // TODO(store-ctx-key-name): `StoreCtx.sessionId` should be `logKey` (or
      // `scopeKey`). One field name carrying two concepts — "which session emitted
      // this" and "which row do I read" — is the same collision this sweep exists
      // to remove, one layer down.
      // NOT AN EVENT SCOPE — the STORE KEY (see the note above).
      { sessionId: this.scopeId },
      {
        store: this.store,
        journalReader: this.journal,
        ...(this.principal !== undefined ? { principal: this.principal } : {}),
      },
    ) as TimelineHydrateCtx;
  }

  /**
   * Durable-backing store label — observability / conformance.
   * `"memory"` for the bundled default.
   */
  get backend(): string {
    return this.store.backend;
  }

  // ─────────── Sync surface — projection (the primary consumer view) ───────────

  read(): TimelineSnapshot {
    return this.log.snapshot();
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.log.subscribe(listener);
  }

  // ─────────── Sync surface — pending (queued, awaiting drain) ───────────

  // ─────────── Sync surface — log (tooling / custom compactors) ───────────

  /**
   * Cursored, seq-tagged read of the durable log (#187) — the in-process face of
   * the `timeline:history` command. Runs the SAME body a wire client reaches, so
   * the read's hooks and guards fire on both paths; it just hands back the rows
   * and drops the paging cursor (an in-process caller holds the last `seq`).
   *
   * @throws {Error} the configured store implements no cursored read — use
   *   `readPersisted()` for the seq-less full read.
   */
  async history(options?: TimelineHistoryInput): Promise<ReadonlyArray<SeqTagged<TimelineEntry>>> {
    const page = await this.historyCmd(options ?? {});
    return page.entries;
  }

  /**
   * The history command body: flush, page, and derive the next cursor.
   *
   * Flushes the write-behind buffer FIRST so a page reflects every completed
   * append (a client that just sent a message and immediately scrolls back must
   * not read a log missing it), then delegates to the store's optional `history`.
   *
   * The cursor follows the read's DIRECTION, which the port's anchor rule fixes:
   * a request carrying `fromSeq` paged forward, so it gets `nextFromSeq`
   * (`lastSeq + 1`); one without paged backward from the tail (or from `toSeq`),
   * so it gets `nextToSeq` (`firstSeq - 1`). Either is present IFF the page
   * FILLED its `limit` — a full page MAY have more that way, a short or uncapped
   * one ran out of log. Both are BOUNDS in a sparse `seq` space, never a claim
   * that an entry sits at them, and `nextToSeq` is omitted at seq 0 (nothing can
   * sit below it).
   */
  private async historyPage(input: TimelineHistoryInput): Promise<TimelineHistoryPage> {
    await this.flush();
    if (this.store.history === undefined) {
      // Loud, not degraded: `fromSeq` is a store-assigned cursor, so answering
      // from a positional `read()` slice would return the WRONG window the
      // moment a prune breaks the correspondence (the `defineTimelineStore.query`
      // precedent).
      throw new Error(
        `TimelineStore "${this.store.backend}" does not implement the optional ` +
          "cursored read (history). Implement it (see runTimelineStoreConformance) " +
          "or use readPersisted() for the seq-less full read.",
      );
    }
    const entries = await this.store.history(this.scopeId, input, this.storeCtx());
    const capped = input.limit !== undefined && entries.length >= input.limit && input.limit > 0;
    if (!capped || entries.length === 0) return { entries };
    if (input.fromSeq !== undefined) {
      return { entries, nextFromSeq: entries[entries.length - 1]!.seq + 1 };
    }
    const firstSeq = entries[0]!.seq;
    return firstSeq > 0 ? { entries, nextToSeq: firstSeq - 1 } : { entries };
  }

  readPersisted(): readonly TimelineEntry[] {
    return this.log.readPersisted();
  }

  // ─────────── Async surface — full Operations ───────────

  /**
   * The Effect-canonical composable surface (ADR 77).
   *
   * `BaseHarness` hands every harness a working `.fx` carrying `use`, so this
   * harness typechecked and resolved with NO operation twins at all — and every
   * append therefore went through the Promise facade below, whose
   * `runHarnessProtocol` is a `runPromise` ROOT that severs the fiber. Since
   * `RuntimeContext` is ambient ON the fiber, the tick scope was gone by the
   * time the append's Operation was built: no timeline envelope was
   * attributable to the tick that caused it. A caller already in a fiber must
   * compose `fx.append` instead.
   */
  get fx(): TimelineHarnessFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      append: (entries) => this.appendFx(entries),
    };
  }

  /**
   * The un-run append — the twin `fx.append` exposes and the Promise facade
   * runs. Zero entries is a no-op that emits NO envelope (the facade's
   * contract), so the check lives here where both paths cross it.
   */
  private appendFx(
    entries: readonly TimelineEntry[],
  ): Effect.Effect<void, TimelineWriteFailed | SubstrateError, never> {
    if (entries.length === 0) return Effect.void;
    return this.commandEffect<TimelineAppendInput, void, TimelineWriteFailed>("timeline:append", {
      entries,
    });
  }

  append(...entries: TimelineEntry[]): Promise<void> {
    return runHarnessProtocol(this.appendFx(entries));
  }

  /**
   * The append command body (runs inside the `timeline:append`
   * operation — declared in the constructor, ADR 51).
   */
  private appendBody(input: TimelineAppendInput): Effect.Effect<void, TimelineWriteFailed, never> {
    // `LogView.append` updates memory synchronously (both tiers), then persists
    // per the write policy: write-through awaits the store and REJECTS with the
    // wrapped `TimelineWriteFailed` on failure; write-behind buffers + kicks the
    // pump and resolves immediately (durability at the `flush()` barrier). A
    // store-write failure is OPERATIONAL, not a defect — the wrapped
    // `TimelineWriteFailed` lands in the error channel so the session barrier
    // can `catchTag` it (same treatment compact() gives its own failure).
    return Effect.tryPromise({
      try: () => this.log.append(input.entries, this.storeCtx()),
      catch: (cause) =>
        cause instanceof TimelineWriteFailed ? cause : new TimelineWriteFailed({ cause }),
    });
  }

  /**
   * Await the write-behind pump — every appended entry is durable in the
   * store on resolution (ADR 49 flush barrier). The loop executor awaits
   * this at execution end, and `session.close()` awaits it via `onClose`.
   * A no-op in `"through"` mode (nothing is ever buffered). Rejects if a
   * buffered store write failed.
   *
   * Invariant: any process that subsequently `read`s the store sees every
   * completed execution.
   */
  flush(): Promise<void> {
    // The write-behind barrier lives in `LogView`; it throws the wrapped
    // `TimelineWriteFailed` (same error the write-through path fails with) if a
    // buffered write failed, LEFT LATCHED — the harness has diverged from its
    // store and cannot silently "recover." The session's execution-end barrier
    // catchTags this and lands the session on "failed" status (A2.2 — see
    // @agentick/session sendBody).
    return this.log.flush();
  }

  /**
   * GENESIS (ADR 93) — run the definition's `hydrate(ctx)` and SEED the
   * harness with what it returns. The resume path (ADR 49 §Hydration), now
   * behind an adopter seam instead of a hardcoded full store read.
   *
   * Called once at session-open: after identity stamping, before first render,
   * before any append (the session chains this ahead of the compiler mount).
   * A no-op when the definition configures neither a `store` nor a `hydrate`.
   *
   * **The seed law.** The returned entries are SEEDED into both tiers — they are
   * NEVER appended, so nothing is written back to the store. A hydrator reads
   * what is already durable (or deliberately synthesizes ephemera); re-appending
   * would duplicate the log on every resume.
   *
   * **Fork/spawn.** Genesis must not run for a child that inherits its parent's
   * image. That decision belongs to the session (it knows its lineage), which
   * simply does not call this — see the session's `genesisReady`.
   *
   * @throws {TimelineError._tag === "TimelineHydrateFailed"} the hydrator threw;
   *   session creation fails rather than half-genesising the session.
   */
  async hydrate(): Promise<void> {
    const hydrate = this.hydrator;
    if (hydrate === undefined) return;
    let entries: readonly TimelineEntry[];
    try {
      entries = await hydrate(this.hydrateCtx());
    } catch (cause) {
      throw cause instanceof TimelineHydrateFailed ? cause : new TimelineHydrateFailed({ cause });
    }
    this.log.seed(entries);
  }

  // TODO(A2.2): on store-write failure the current pump batch is dropped and
  // the rejection surfaces via `flush()` (now inside `LogView.runPump`). ADR 49
  // wants this to transition the session to an errored status + retry per
  // adapter policy — that belongs in the session/loop-executor barrier.

  compact(strategy?: CompactStrategy): Promise<CompactResult> {
    if (strategy === undefined) {
      // Signal form (ADR 51): the declared `timeline:compact` command —
      // same path a bare verb takes over the inbox. Runs the
      // construction-bound default; rejects with CompactStrategyMissing
      // when none is configured.
      return this.compactCmd({});
    }
    // Explicit-arg form: an in-process-only override (inner-scope-wins).
    // Stays a hand-built Operation BY DOCTRINE — the input carries a
    // function (the strategy), so it can never be a declared command
    // (ADR 51 §1.2: executable configuration is unaddressable).
    const op: Operation<CompactStrategy, CompactResult, CompactHandlerFailed> = {
      opId: `timeline:compact:${ulid()}`,
      surface: "timeline",
      name: "timeline:command:compact",
      scope: {},
      input: strategy,
    };
    return runHarnessProtocol(this.runOperation(op, (s) => this.compactBody(s)));
  }

  /**
   * The compaction body — shared by the explicit-arg operation above
   * and the declared signal-form command (constructor). `source`
   * selects the fold INPUT (full log vs current projection); the
   * mutation target is always the projection (`log.replaceProjection`)
   * — the durable log is never rewritten.
   */
  private compactBody(
    s: CompactStrategy,
  ): Effect.Effect<CompactResult, CompactHandlerFailed, never> {
    const source: "persisted" | "projection" = s.source ?? "persisted";
    return Effect.gen(this, function* () {
      const sourceEntries = source === "persisted" ? this.log.readPersisted() : this.log.read();
      const before = sourceEntries.length;
      // A compaction strategy's `run` is typically a model call (the
      // contract says so) — its failure is OPERATIONAL (timeout,
      // rate-limit), not a programming defect. Surface it as the typed,
      // catchable CompactHandlerFailed in the error channel, NOT an
      // orDie defect: an adopter (ernesto's LLM compactor) can catchTag
      // it and retry / skip compaction / error the session.
      const next = yield* Effect.tryPromise({
        try: () =>
          s.run({
            entries: sourceEntries,
            ...omitUndefined({ instructions: s.instructions }),
          }),
        catch: (cause) => new CompactHandlerFailed({ cause }),
      });
      const entries = [...next];
      this.log.replaceProjection(entries, {
        at: Date.now(),
        source,
        entriesBefore: before,
        entriesAfter: entries.length,
        ...omitUndefined({ strategyMetadata: s.metadata }),
      });
      const result: CompactResult = {
        entriesBefore: before,
        entriesAfter: entries.length,
        source,
      };
      return result;
    });
  }

  replaceProjection(input: TimelineReplaceProjectionInput): Promise<void> {
    return this.replaceProjectionCmd(input);
  }

  /** The replaceProjection command body (declared in the constructor). */
  private replaceProjectionBody(
    i: TimelineReplaceProjectionInput,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const entries = [...i.entries];
      this.log.replaceProjection(entries, {
        at: Date.now(),
        source: "projection",
        entriesBefore: this.log.read().length,
        entriesAfter: entries.length,
      });
    });
  }

  resetProjection(): Promise<void> {
    return this.resetProjectionCmd(undefined);
  }

  /** The resetProjection command body (declared in the constructor). */
  private resetProjectionBody(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.log.resetProjection();
    });
  }

  // ─────────── Turn boundaries (ADR 53, simplified) ───────────
  //
  // Consumption is NON-DESTRUCTIVE — the loop re-renders the whole log
  // every tick — so nothing here is load-bearing. The boundary entry is
  // an emitted RECORD (segmentation + turn-aggregate usage); the
  // trailing-input fold is a derived convenience.

  /** Input predicate (ADR 53 §2.5) — a named constant, not config. */
  private static isInputEntry(e: TimelineEntry): e is MessageTimelineEntry {
    return e.kind === "message" && e.message.role === "user";
  }

  /**
   * Input entries after the LAST assistant entry — the trailing-input fold (ADR 53 §2.3b). UI styling and resume prompts read
   * this; NOTHING load-bearing does. Multi-tick turns append one
   * assistant entry per generation; "after the last" still detects
   * the trailing set correctly.
   */
  trailingInput(): readonly MessageTimelineEntry[] {
    const persisted = this.log.readPersisted();
    let lastAssistant = -1;
    for (let i = persisted.length - 1; i >= 0; i--) {
      const e = persisted[i]!;
      if (e.kind === "message" && e.message.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    const out: MessageTimelineEntry[] = [];
    for (let i = lastAssistant + 1; i < persisted.length; i++) {
      const e = persisted[i]!;
      if (TimelineHarness.isInputEntry(e)) out.push(e);
    }
    return out;
  }

  /** Count of input entries in the persisted log — the session's live
   *  continuation check compares this across ticks. O(n); fine at
   *  conversation scale, revisit with a counter if it ever shows up. */
  inputEntryCount(): number {
    let n = 0;
    for (const e of this.log.readPersisted()) if (TimelineHarness.isInputEntry(e)) n++;
    return n;
  }

  /**
   * Emit the turn-boundary RECORD (ADR 53 §2.3b) — segmentation, outcome, the turn's
   * aggregate usage (which may exceed the entry-sum when a tick billed tokens but
   * appended nothing), and the target that ran it.
   *
   * Read by NOTHING in the framework for behavior — it is a record, not a control signal
   * — and disableable via `options.turnBoundaries: false`. It is written for readers: a
   * UI segmenting a conversation, an eval, and an application computing its own "entries
   * since the last comparable success" window when a turn starts failing.
   */
  endTurn(input: {
    readonly executionId: string;
    readonly outcome: "succeeded" | "failed" | "aborted" | "vetoed";
    readonly usage?: UsageStats;
    /**
     * The turn's PER-MODEL breakdown. The flat `usage` above is safe to sum
     * and meaningless to price — a turn changes model (a per-tick `<Model>`,
     * a steer, a `setModel`), so it routinely mixes rate tiers. This is the
     * shape cost is actually a function of.
     */
    readonly byModel?: Readonly<Record<string, ModelUsage>>;
    /**
     * What the turn cost, folded from per-tick costs stamped at act time.
     * `partial` when any tick was unpriced — an unpriced tick never folds in
     * as a zero, so the total is either complete or says how much of itself
     * is missing.
     */
    readonly cost?: CostRollup;
    readonly stopCause?: StopCause;
    readonly target?: { readonly provider?: string; readonly modelId?: string };
  }): Promise<void> {
    if (!this.turnBoundaries) return Promise.resolve();
    const entry: TurnBoundaryEntry = {
      kind: "boundary",
      boundary: {
        executionId: input.executionId,
        outcome: input.outcome,
        // The cause rides the record, not just the outcome: a turn that dies
        // before its first tick appends no assistant entry, so this boundary is
        // the only durable evidence the turn happened — and an outcome with no
        // cause tells a reloaded client that something ended badly, and no more.
        // `target` rides the record because a SUCCEEDED boundary is a proof of
        // projectability, and a proof is only about the target that gave it. An
        // application narrowing its suspects to "entries since the last success" needs to
        // know whether that success is comparable — a failover or a model swap makes it
        // not. This is the one part of that fold the application cannot derive itself.
        // This spread is an ALLOWLIST — a field absent from it is silently
        // dropped, which is how `byModel` / `cost` went missing at first.
        ...omitUndefined({
          usage: input.usage,
          byModel: input.byModel,
          cost: input.cost,
          stopCause: input.stopCause,
          target: input.target,
        }),
      },
      ts: Date.now(),
      visibility: "log",
    };
    return this.append(entry);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): TimelineHarnessSnapshot {
    return this.log.exportSnapshot();
  }

  async importSnapshot(
    snapshot: TimelineHarnessSnapshot,
    options: TimelineImportSnapshotOptions = {},
  ): Promise<void> {
    const mode = options.mode ?? "as-is";

    switch (mode) {
      case "as-is": {
        // Trust the snapshot's projection verbatim.
        this.log.importSnapshot(snapshot, { mode: "as-is" });
        return;
      }
      case "persisted-only": {
        // Restore the durable log; projection re-mirrors persisted.
        this.log.importSnapshot(snapshot, { mode: "reset-projection" });
        return;
      }
    }
  }

  // ─────────── Inbox routing ───────────

  /**
   * All timeline verbs are DECLARED COMMANDS (ADR 51) — the command
   * registry in `BaseHarness.dispatchMessage` routes
   * `timeline:append/queue/drain/replaceProjection/resetProjection/compact`
   * before this fallthrough is ever consulted. Only unknown types land
   * here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown timeline message type: ${msg.type}` }));
  }
}
