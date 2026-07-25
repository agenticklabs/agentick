/**
 * `SkillsHarness` — durable library of agent skills.
 *
 * Per ADR 32, this is a Shape 1 harness extension:
 *   - Audit envelopes for every register / update / remove
 *   - Snapshot/restore via `SnapshotCapable` feature detection
 *   - Inbox-addressable for cross-actor mutations (cluster peers,
 *     admin dashboards, sibling harnesses) — all three verbs are
 *     declared commands (ADR 51): `skills:register` / `skills:update`
 *     / `skills:remove` route through the BaseHarness command
 *     registry with zero routing code
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * In-memory reference impl. Durable backends (sqlite, remote
 * `agentskills.io` registry) implement the same protocol and pass
 * the same conformance suite.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see packages/spec/src/protocol/skills-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime";
import type {
  CollectionMutation,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  RunnerBindable,
  SendInput,
  SessionSendCapability,
  Store,
  Skill,
  SkillStoreQuery,
  SkillsError,
  SkillsHarnessProtocol,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
  SessionExecutionHandle,
} from "@agentick/spec";
import {
  HandlerError,
  SkillAlreadyExists,
  SkillIsolationUnavailable,
  SkillNotFound,
  SkillRunnerUnbound,
} from "@agentick/spec";
import { View } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";

import type { SkillLoader } from "./loaders.js";
import type { SkillRunCompose, SkillRunOptions } from "./handle.js";
import { defaultComposeRun } from "./compose-run.js";
import { InMemorySkillStore, matchesSkillQuery } from "./store.js";

function skillContentChanged(existing: Skill, incoming: SkillsRegisterInput): boolean {
  if (existing.description !== incoming.description) return true;
  if (existing.content !== incoming.content) return true;
  const existingTags = existing.tags ? [...existing.tags].sort().join("|") : "";
  const incomingTags = incoming.tags ? [...incoming.tags].sort().join("|") : "";
  if (existingTags !== incomingTags) return true;
  const existingAllowed = existing.allowedTools ? [...existing.allowedTools].sort().join("|") : "";
  const incomingAllowed = incoming.allowedTools ? [...incoming.allowedTools].sort().join("|") : "";
  if (existingAllowed !== incomingAllowed) return true;
  return false;
}

// ============================================================================
// Harness
// ============================================================================

const SURFACE = "skills" as const;

// `skills` is not in the EventSurface union yet — add it via a cast
// at construction; spec-level addition is a one-line follow-up. For
// now we declare locally as the surface tag used by BaseHarness.
type SkillsSurface = typeof SURFACE;

/**
 * Construction options for {@link SkillsHarness}. Threaded through
 * `withSkills({ store })` for adopters who want a durable backing (Postgres, a
 * filesystem source) behind the same {@link Store} seam.
 */
export interface SkillsHarnessOptions {
  /**
   * Durable backing for skill records (data-layer plan §6-C, Phase 5). Defaults
   * to a fresh per-harness in-memory {@link InMemorySkillStore}. The store holds
   * the WHOLE `Skill` (skills are fully serializable — the archetype's pure
   * floor, no runtime augmentation to strip). It is the durable truth; the
   * synchronous {@link View} is its sync read cache (reads never touch
   * the store). Injecting a durable adapter is how skills survive process
   * restart; `hydrate()` loads it back into the view. Typed against the
   * `Store` SEAM — a durable adapter need only implement `query`/`mutate`.
   *
   * NOTE the view (not async-through-the-store like credentials): skills
   * carries a SYNC `exportSnapshot(): Record<string, Skill>` (the generic
   * `captureBridgeSnapshots` calls it synchronously, un-awaited) AND a sync
   * `get`/`has`/`list`/`search` protocol surface — both are load-bearing sync
   * callers, so a synchronous materialized view is required. Credentials, the
   * async counter-example, has NO snapshot surface, which is why it needs no
   * view.
   */
  readonly store?: Store<Skill, SkillStoreQuery, CollectionMutation<Skill>>;
  /**
   * The `skills.run` composition seam (three-audiences-plan §C). Maps a
   * resolved skill + run options to the `SendInput` the runner executes.
   * Defaults to {@link defaultComposeRun} (system-role skill message +
   * user-role args message). Threaded from `withSkills({ composeRun })`.
   */
  readonly composeRun?: SkillRunCompose;
}

export class SkillsHarness
  extends BaseHarness<SkillsSurface>
  implements SkillsHarnessProtocol, RunnerBindable
{
  /**
   * The synchronous {@link View} of the skill store (data-layer plan
   * §3.5 P5) — ONE primitive that collapses the two fields this used to
   * hand-roll (a `CollectionProjection` for the sync cache + write-through and a
   * `KeyedNotifier` for render pings). `get` / `has` / `list` / `search` read it
   * during render (sync, never async-through-the-store); `exportSnapshot`
   * materializes it synchronously; `applyRegister` / `applyUpdate` / `applyRemove`
   * write through it (sync cache first, durable store off the critical path via
   * the `query`/`mutate` seam) and each single write pings the key. Skills are
   * whole serializable records (the cache value IS the stored `Skill`), so the
   * pure-mirror collection view fits without refinement. Keyed by `Skill.name`.
   * No `onChange` subscriber — skills has no client-facing change channel.
   */
  private readonly view: View<Skill, Skill, SkillStoreQuery, CollectionMutation<Skill>>;

  /** Cached snapshot for `list()`. Invalidated on every mutation. */
  private listCache: readonly Skill[] | null = null;

  /**
   * Loaders retained from `withSkills({ loaders })`. Drive
   * post-startup `reload()` + `resolve(name)` (lookup-on-miss).
   * Empty when no loaders were configured.
   */
  private loaders: readonly SkillLoader[] = [];

  /**
   * Late-bound send capability (C-core — three-audiences-plan §C). Injected at
   * session install via {@link bindRunner}; drives `run`. `undefined` on a
   * harness constructed outside a session — `run` then throws
   * `SkillRunnerUnbound` rather than dereferencing it.
   */
  private runner?: SessionSendCapability;

  /**
   * Late-bound ISOLATED send capability (C2 — three-audiences-plan §C split,
   * item 3). Injected at session install via {@link bindIsolationRunner};
   * routes a run through `session.fork()` (a same-image, copied-state child
   * disposed after the run) instead of the current session. `undefined` when
   * no isolation runner was bound — `run({ isolate: true })` then throws
   * `SkillIsolationUnavailable` (the pre-C2 behavior).
   */
  private isolationRunner?: SessionSendCapability;

  /** The run-composition seam. `withSkills({ composeRun })` or the default. */
  private readonly composeRun: SkillRunCompose;

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns Operation construction, inbox routing, and
   * enumeration. All three inputs are serializable data, so every
   * skills verb is addressable (no function-carrying operations stay
   * hand-built here). Payloads carried no validation before the
   * registry; schemas stay off for parity.
   */
  readonly register: (input: SkillsRegisterInput) => Promise<Skill>;
  readonly update: (input: SkillsUpdateInput) => Promise<Skill>;
  readonly remove: (input: SkillsRemoveInput) => Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SkillsHarnessOptions = {},
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    this.composeRun = options.composeRun ?? defaultComposeRun;
    this.view = View.collection(options.store ?? new InMemorySkillStore(), (s) => s.name);
    const scope = () => ({ sessionId: this.scopeId });
    this.register = this.command({
      name: "skills:register",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: SkillsRegisterInput) => this.applyRegister(i),
    });
    this.update = this.command({
      name: "skills:update",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: SkillsUpdateInput) => this.applyUpdate(i),
    });
    this.remove = this.command({
      name: "skills:remove",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: SkillsRemoveInput) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
    });

    // ─── Wire read commands (three-audiences-plan G-prep) — skills had
    // register/update/remove only, NO wire read, so enumeration was
    // wire-unreachable. These add the read lane a client skills handle needs.
    // Registered for their side effect (wire-reachability + `commands/list`
    // enumeration); the SYNC `list`/`get`/`search` serve in-process reads, so the
    // returned callables are discarded. A `Skill` is fully serializable, so the
    // wire projection IS the record — content INCLUDED (a client managing skills
    // needs the body; note the body is unbounded, so `search` should scope large
    // libraries rather than `list` pulling everything).
    this.command({
      name: "skills:list",
      exposure: "wire",
      scope,
      handler: () => Effect.sync(() => this.list()),
    });
    this.command({
      name: "skills:get",
      exposure: "wire",
      scope,
      handler: (i: { name: string }) => Effect.sync(() => this.get(i.name) ?? null),
    });
    this.command({
      name: "skills:search",
      exposure: "wire",
      scope,
      handler: (i: SkillsSearchInput) => Effect.sync(() => this.search(i)),
    });
  }

  /**
   * Replace the loader set used by `reload()` and `resolve()`.
   * Called by `withSkills` at install time; adopters can also swap the
   * loader set at runtime (e.g., add a new source after startup).
   */
  setLoaders(loaders: readonly SkillLoader[]): void {
    this.loaders = loaders;
  }

  // ─────────── Runner (late-bound send capability) ───────────

  /**
   * Inject the session's `send` capability (C-core — three-audiences-plan §C
   * split, item 1). Called once at session install (the app's
   * session-construction fold feature-detects `RunnerBindable` and binds). The
   * harness is constructed from substrate alone — it has NO session access —
   * so `run` reaches `session.send` only through this late-bound capability
   * (the `adoptTelemetry` precedent). Handed ONLY the send capability, never
   * the full session.
   */
  bindRunner(send: SessionSendCapability): void {
    this.runner = send;
  }

  /**
   * Inject the session's ISOLATED send capability (C2 — three-audiences-plan
   * §C split, item 3). Optional sibling to {@link bindRunner}: where
   * `bindRunner` runs a send in THIS session, an isolation runner runs it in a
   * fresh `session.fork()` (a same-image, copied-state child disposed after
   * the run settles) — the isolation `skills.run({ isolate: true })` needs. The
   * composition root binds it at session install exactly as it binds
   * `bindRunner`; a harness with none stays pre-C2 (isolation throws).
   */
  bindIsolationRunner(runner: SessionSendCapability): void {
    this.isolationRunner = runner;
  }

  /**
   * Run a skill: compose a send from the skill's content, execute it via the
   * bound runner, and return the execution handle unchanged — one grammar with
   * `session.send`. The
   * skill guides; the MODEL executes (Flue-aligned — skills add no executable
   * capability). Inline only in C-core.
   *
   * @throws {SkillIsolationUnavailable} `opts.isolate: true` with no isolation
   *   runner bound (a harness outside a session, or one whose composition root
   *   never bound `bindIsolationRunner`).
   * @throws {SkillRunnerUnbound} no runner bound (harness outside a session).
   * @throws {SkillNotFound} no skill named `name` (via {@link require}).
   * @throws Propagated send errors: `ResponseValidationError` /
   *   `StructuredOutputIncomplete` (§B2). An `output`-carrying run that races an
   *   in-flight execution does NOT throw — it queues (smart default) and runs
   *   after quiescence.
   */
  async run<T = unknown>(
    name: string,
    opts: SkillRunOptions<T> = {},
  ): Promise<SessionExecutionHandle<T>> {
    // C2 — an isolation request routes through the isolation runner (a
    // `session.fork()`-backed send) when one is bound; with none it STILL
    // throws (never silently degrade to a same-session run).
    const isolate = opts.isolate === true;
    if (isolate && this.isolationRunner === undefined) {
      throw new SkillIsolationUnavailable({ skillName: name });
    }
    const runner = isolate ? this.isolationRunner : this.runner;
    if (runner === undefined) {
      throw new SkillRunnerUnbound({ skillName: name });
    }
    // Throws SkillNotFound on a miss — let it propagate (must-exist contract).
    const skill = await this.require(name);
    const input: SendInput = this.composeRun(skill, opts as SkillRunOptions);
    // The run IS a send — the handle passes through untouched (streaming via
    // `for await (const ev of handle.events())`, `abort()`, `status`, and the
    // typed `result`: `data` is validated against `opts.output` by the send
    // path, so the cast narrows what validation already guarantees).
    // `.result` may reject (steer-conflict, validation, incomplete) — the
    // typed error propagates to whoever awaits it. The isolation runner threads
    // the same composed send through a forked child and disposes it after the
    // handle settles.
    return (await runner(input)) as SessionExecutionHandle<T>;
  }

  // ─────────── Dynamic surface ───────────

  /**
   * Re-run every configured loader, diff against current state, apply
   * adds + updates (and removes when `pruneMissing: true`). Loader
   * errors propagate — wrap individual loaders if you need fallback.
   *
   * Returns a summary of names touched.
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    const batches = await Promise.all(this.loaders.map((l) => l.load()));
    const fresh = new Map<string, SkillsRegisterInput>();
    for (const batch of batches) {
      for (const skill of batch) fresh.set(skill.name, skill);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const [name, record] of fresh) {
      if (this.view.hasSync(name)) {
        const existing = this.view.getSync(name)!;
        if (skillContentChanged(existing, record)) {
          await this.update({
            name,
            description: record.description,
            content: record.content,
            ...(record.tags ? { tags: record.tags } : {}),
            ...(record.allowedTools ? { allowedTools: record.allowedTools } : {}),
            ...(record.metadata ? { metadata: record.metadata } : {}),
          });
          updated.push(name);
        }
      } else {
        await this.register(record);
        added.push(name);
      }
    }
    const removed: string[] = [];
    if (opts.pruneMissing) {
      for (const name of this.view.listSync().map((s) => s.name)) {
        if (!fresh.has(name)) {
          await this.remove({ name });
          removed.push(name);
        }
      }
    }
    return { added, updated, removed };
  }

  /**
   * Lookup-on-miss: returns the registered skill if present; otherwise
   * asks each loader (via `lookup` or `load()` + filter) and registers
   * the first match. Returns `null` if no loader has the name.
   */
  async resolve(name: string): Promise<Skill | null> {
    const existing = this.view.getSync(name);
    if (existing) return existing;
    for (const loader of this.loaders) {
      const found = loader.lookup
        ? await loader.lookup(name)
        : ((await loader.load()).find((s) => s.name === name) ?? null);
      if (found) {
        await this.register(found);
        return this.view.getSync(name) ?? null;
      }
    }
    return null;
  }

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `SkillNotFound`-tagged error instead of returning `null` when
   * no loader has the name. Use when the absence of a name is a
   * programming error (must-exist contract), not a domain case.
   */
  async require(name: string): Promise<Skill> {
    const resolved = await this.resolve(name);
    if (resolved !== null) return resolved;
    throw new SkillNotFound({ skillName: name });
  }

  // ─────────── Sync surface ───────────

  get(name: string): Skill | undefined {
    return this.view.getSync(name);
  }

  has(name: string): boolean {
    return this.view.hasSync(name);
  }

  list(): readonly Skill[] {
    if (this.listCache !== null) return this.listCache;
    const out: Skill[] = this.view.listSync().slice();
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.listCache = out;
    return out;
  }

  search(input: SkillsSearchInput): readonly Skill[] {
    const limit = input.limit ?? 50;
    // The store-level filter shares `matchesSkillQuery` with the store's async
    // `list(query)`; `limit` is the harness's read-cap, applied to the slice.
    const query: SkillStoreQuery = omitUndefined({
      query: input.query,
      tagsAny: input.tagsAny,
      tagsAll: input.tagsAll,
    });
    const out: Skill[] = [];
    for (const skill of this.list()) {
      if (!matchesSkillQuery(skill, query)) continue;
      out.push(skill);
      if (out.length >= limit) break;
    }
    return out;
  }

  subscribe(name: string, listener: () => void): Unsubscribe {
    return this.view.subscribe(name, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.view.subscribeAll(listener);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, Skill>> {
    // Reads the sync view cache — MUST stay synchronous: the generic
    // `captureBridgeSnapshots` invokes this un-awaited (SnapshotCapable). Skills
    // are whole records (no augmentation to strip), so the cell IS the snapshot.
    const out: Record<string, Skill> = {};
    for (const skill of this.view.listSync()) out[skill.name] = skill;
    return out;
  }

  importSnapshot(snapshot: Readonly<Record<string, Skill>>): void {
    // Wholesale replace via the view: keys absent from the snapshot are dropped
    // from BOTH the cache and the store; each snapshot cell writes through. The
    // view mutates the whole cache FIRST then batch-pings the union (drops ∪
    // upserts), so invalidate `listCache` BEFORE `replace` and a subscriber
    // reading during a ping sees the complete post-import list. `replace` is
    // change-SILENT (skills has no per-key change channel). NOTE: the old
    // `notifier.notifyAll()` fired the wildcard once; `replace` pings each
    // touched key, which fires the keyed bucket AND the wildcard per key — a
    // superset (more precise), never fewer.
    //
    // TODO(store-phase-4): `importSnapshot` is the ACTIVE snapshot-based resume
    // path. The Phase-4 manifest sweep replaces it with `hydrate()` once the
    // store is the authority. Do NOT wire `hydrate()` into resume while this
    // method still owns it.
    this.listCache = null;
    this.view.replace(Object.values(snapshot), this.storeCtx());
  }

  /**
   * Load the durable store into the sync view — the future manifest resume
   * path (data-layer plan Phase 4 / BaseHarness §2.3). A MERGE (store records
   * overlay the view), not a clear-first replace — a fresh session's store
   * is empty ⇒ a no-op. Invalidates `list()`; the view pings each hydrated key.
   *
   * NOT wired into session resume in this run: `importSnapshot` remains the
   * active resume path. `hydrate()` is the seam the Phase-4 manifest sweep flips
   * to once the store is authority.
   */
  async hydrate(): Promise<void> {
    // The view merges the store projection into the cache and pings each loaded
    // key. Invalidate `listCache` BEFORE the merge+ping so a subscriber re-reads
    // the hydrated list.
    this.listCache = null;
    await this.view.hydrate(undefined, this.storeCtx());
  }

  // ─────────── Inbox routing ───────────

  /**
   * `skills:register` / `skills:update` / `skills:remove` are declared
   * commands — routed by the BaseHarness command registry before this
   * fallthrough. Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown skills message type: ${msg.type}` }));
  }

  // ─────────── Private mutation helpers ───────────

  private applyRegister(input: SkillsRegisterInput): Effect.Effect<Skill, SkillsError, never> {
    return Effect.suspend((): Effect.Effect<Skill, SkillsError, never> => {
      if (this.view.hasSync(input.name)) {
        return Effect.fail(new SkillAlreadyExists({ skillName: input.name }));
      }
      const now = Date.now();
      const skill: Skill = {
        name: input.name,
        description: input.description,
        content: input.content,
        ...omitUndefined({
          tags: input.tags,
          allowedTools: input.allowedTools,
          metadata: input.metadata,
        }),
        createdAt: now,
        updatedAt: now,
      };
      // One write through the view: sync cache first (reads reflect it now),
      // durable store off the critical path via the seam, and a render ping —
      // the dual-write + notify collapsed. Invalidate `listCache` BEFORE the
      // write so a subscriber that reads during the ping sees the fresh list.
      this.listCache = null;
      this.view.write(skill, this.storeCtx());
      return Effect.succeed(skill);
    });
  }

  private applyUpdate(input: SkillsUpdateInput): Effect.Effect<Skill, SkillsError, never> {
    return Effect.suspend((): Effect.Effect<Skill, SkillsError, never> => {
      const existing = this.view.getSync(input.name);
      if (!existing) {
        return Effect.fail(new SkillNotFound({ skillName: input.name }));
      }
      const updated: Skill = {
        ...existing,
        ...omitUndefined({
          description: input.description,
          content: input.content,
          tags: input.tags,
          allowedTools: input.allowedTools,
        }),
        ...(input.metadata !== undefined
          ? { metadata: { ...(existing.metadata ?? {}), ...input.metadata } }
          : {}),
        updatedAt: Date.now(),
      };
      this.listCache = null;
      this.view.write(updated, this.storeCtx());
      return Effect.succeed(updated);
    });
  }

  private applyRemove(input: SkillsRemoveInput): void {
    // Idempotent — the view's `deleteSync` fires nothing on an absent name. The
    // `hasSync` guard keeps the `listCache` invalidation off the no-op path.
    if (this.view.hasSync(input.name)) {
      this.listCache = null;
      this.view.deleteSync(input.name, this.storeCtx());
    }
  }
}
