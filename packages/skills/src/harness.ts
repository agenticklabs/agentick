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
import {
  BaseHarness,
  qualifyNamespaceGuards,
  qualifyNamespaceHooks,
  type BaseHarnessOptions,
  type Unsubscribe,
} from "@agentick/runtime";
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
  SkillsHydrateFailed,
} from "@agentick/spec";
import { View } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";

import type {
  SkillSeed,
  SkillsDefinition,
  SkillsHydrateCtx,
  SkillsHydrator,
  SkillsStore,
} from "./definition.js";
import type { SkillRunCompose, SkillRunOptions } from "./handle.js";
import { defaultComposeRun } from "./compose-run.js";
import { InMemorySkillStore, matchesSkillQuery } from "./store.js";

function skillContentChanged(existing: Skill, incoming: SkillSeed): boolean {
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

/**
 * Normalize a genesis {@link SkillSeed} into the stored {@link Skill}. Timestamps
 * the seed CARRIES are preserved — a store replay keeps its real history rather
 * than being restamped as brand new — and absent ones default to `now`.
 */
function seededSkill(seed: SkillSeed, now: number): Skill {
  return {
    name: seed.name,
    description: seed.description,
    content: seed.content,
    ...omitUndefined({
      tags: seed.tags,
      allowedTools: seed.allowedTools,
      metadata: seed.metadata,
    }),
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

// ============================================================================
// Harness
// ============================================================================

const SURFACE = "skills" as const;

// `skills` is not in the EventSurface union yet — add it via a cast
// at construction; spec-level addition is a one-line follow-up. For
// now we declare locally as the surface tag used by BaseHarness.
type SkillsSurface = typeof SURFACE;

// ADR 80/83 — type the skills verbs on the command registry. This is what mints
// `onBeforeSkillsRegister` / `onAfterSkillsRegister` (and the `guards:
// { skillsRegister }` key) on the app-level derived surfaces, and — via the
// drop-layer projections — `NamespaceHooks<"skills">` / `NamespaceGuards<"skills">`
// for the definition's own bags. Without these rows both bags are the empty
// object and the sugar advertises nothing (ADR 93 landmine 11's type half).
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "skills:register": { input: SkillsRegisterInput; output: Skill };
    "skills:update": { input: SkillsUpdateInput; output: Skill };
    "skills:remove": { input: SkillsRemoveInput; output: void };
    "skills:list": { input: undefined; output: readonly Skill[] };
    "skills:get": { input: { readonly name: string }; output: Skill | null };
    "skills:search": { input: SkillsSearchInput; output: readonly Skill[] };
  }
}

/**
 * Construction options for {@link SkillsHarness} — the {@link SkillsDefinition}
 * (store · genesis · shaping seams · `hooks:` / `guards:`) plus the
 * {@link BaseHarnessOptions} the substrate needs (journaling policy, the
 * interceptor-inheritance handle).
 *
 * There is ONE options shape: `withSkills(...)`, `createApp({ skills })`, and
 * this constructor all take the same definition. The extension spreads
 * `inheritedFrom(installer)` in on top so the app/session interceptor cascade
 * reaches this harness (ADR 93 landmine 11).
 */
export interface SkillsHarnessOptions extends BaseHarnessOptions, SkillsDefinition {}

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
   * The definition's own store — held so the genesis ctx can hand it to a
   * hydrator as the typed `ctx.store` facet.
   */
  private readonly store: SkillsStore;

  /**
   * The GENESIS seam (ADR 93), resolved at construction from the definition's
   * `hydrate` slot. **No default** — unlike the timeline, a configured `store`
   * does not imply a store read: which slice of a catalog a session opens with is
   * a policy question, so it is asked for explicitly (`hydrate:
   * hydrateFromStore()`). `undefined` means the library opens empty.
   *
   * It is also THE source `reload()` and `resolve(name)` re-run — the source
   * unification (ADR 93 rendered-moot #3) collapsed the old `loaders: []` array
   * and `initial: []` bag into this one seam.
   */
  private hydrator?: SkillsHydrator;

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
    // Thread the substrate options through — journaling policy AND the
    // interceptor-inheritance handle (ADR 93 landmine 11). Without the latter
    // an extension-installed skills harness is INVISIBLE to `app.guard()` /
    // `createApp({ hooks, guards })`, which becomes a correctness bug the moment
    // the definition advertises its own `hooks:` / `guards:` bags.
    super(SURFACE, scopeId, journal, bus, inbox, options);
    this.composeRun = options.composeRun ?? defaultComposeRun;
    this.store = options.store ?? new InMemorySkillStore();
    this.view = View.collection(this.store, (s) => s.name);
    // Genesis (ADR 93): the definition's hydrator, resolved — not RUN — here.
    // Definitions are inert until install; genesis runs at session-open via
    // `hydrate()`. No default: a `store` alone loads nothing.
    this.hydrator = options.hydrate as SkillsHydrator | undefined;
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

    // ─── The definition's `hooks:` / `guards:` bags (ADR 93) ───
    //
    // DROP-LAYER keys (`onBeforeRegister`, `guards: { register }`) requalify onto
    // the discriminated commands (`onBeforeSkillsRegister`, `SkillsRegister`) and
    // register on this harness's OWN chain — deliberately NARROWER than the
    // `inheritedInterceptors` an app/session hands down. That is the cascade law:
    // broader scope wraps narrower, so app before-hooks run first and app guards
    // veto before a definition guard is consulted.
    if (options.hooks !== undefined) {
      this.hook(qualifyNamespaceHooks("skills", options.hooks as Record<string, unknown>));
    }
    if (options.guards !== undefined) {
      this.guard(qualifyNamespaceGuards("skills", options.guards as Record<string, unknown>));
    }
  }

  /**
   * Swap the source hydrator after construction — the runtime half of the source
   * seam. `reload()` and `resolve()` use whatever is set here, so this is how an
   * adopter adds (or retires) a source mid-session. Pass `undefined` to detach
   * the source entirely; genesis has already run either way.
   */
  setHydrator(hydrate: SkillsHydrator | undefined): void {
    this.hydrator = hydrate;
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
   * Re-run the source hydrator, diff against current state, and apply adds +
   * updates (and removes when `pruneMissing: true`). Hydrator errors propagate —
   * wrap the hydrator if you need per-source fallback.
   *
   * Unlike GENESIS, a reload goes through the OPS (`skills:register` /
   * `skills:update` / `skills:remove`), so the diff is journaled, guard-vetoable,
   * and durable. The seed exemption is a session-open concession, not a licence
   * for every later read of the source.
   *
   * A harness with NO hydrator reloads to nothing touched — including under
   * `pruneMissing`, because the absence of a source is not a claim that the
   * library should be empty.
   *
   * Returns a summary of names touched.
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    // NO SOURCE is not the same statement as AN EMPTY SOURCE. A detached (or
    // never-attached) hydrator has nothing to say about what the library should
    // hold, so a reload is a total no-op — in particular `pruneMissing` must not
    // read the absence of a source as "the source has nothing" and wipe the
    // library.
    if (this.hydrator === undefined) return { added: [], updated: [], removed: [] };
    const fresh = new Map<string, SkillSeed>();
    for (const record of await this.runHydrator()) fresh.set(record.name, record);
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
   * Lookup-on-miss: returns the registered skill if present; otherwise re-runs the
   * source hydrator and registers the first record with that name. Returns `null`
   * when the source does not have it.
   *
   * The hydrator produces the WHOLE source set, so a miss costs a full source
   * read. That is the honest price of one source seam, and it matches what the
   * loader vocabulary actually did (every filesystem / URL source's `lookup` was
   * already `load()` + find). For a catalog large enough to care, put it behind a
   * `store` — the store's `query` IS the targeted read port, and
   * `hydrateFromStore()` opens on it.
   */
  async resolve(name: string): Promise<Skill | null> {
    const existing = this.view.getSync(name);
    if (existing) return existing;
    if (this.hydrator === undefined) return null;
    const found = (await this.runHydrator()).find((s) => s.name === name);
    if (found === undefined) return null;
    await this.register(found);
    return this.view.getSync(name) ?? null;
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
    // TODO(store-phase-4): `importSnapshot` is still the snapshot-based resume
    // path for a session restored from an IMAGE. Genesis (`hydrate()`) is the
    // store-authority path; the Phase-4 manifest sweep retires this one.
    this.listCache = null;
    this.view.replace(Object.values(snapshot), this.storeCtx());
  }

  // ─────────── Genesis (ADR 93) ───────────

  /**
   * GENESIS (ADR 93) — run the definition's `hydrate(ctx)` and SEED the library
   * with what it returns.
   *
   * Called once at session-open: after identity stamping, before first render,
   * before any register. A no-op when the definition configures no `hydrate` —
   * skills names no default hydrator, so a `store` alone opens empty (which slice
   * of a catalog a session should open with is a policy question).
   *
   * **The seed law.** The returned records are ADOPTED into the read view: no
   * `skills:register` op, no store write. A hydrator reads what is already
   * durable (or deliberately treats files as the source of truth); re-registering
   * would duplicate the catalog on every resume — and for `hydrateFromStore()` it
   * would write the store back onto itself. Timestamps a record carries are
   * PRESERVED (a store replay keeps its real history); absent ones default to now.
   *
   * **Fork/spawn.** Genesis must not run for a child that inherits its parent's
   * image. That decision belongs to the session (it knows its lineage), which
   * simply does not install a fresh genesis for a fork.
   *
   * @throws {SkillsError._tag === "SkillsHydrateFailed"} the hydrator threw;
   *   session creation fails rather than half-genesising the library.
   */
  async hydrate(): Promise<void> {
    if (this.hydrator === undefined) return;
    const records = await this.runHydrator();
    // Invalidate `listCache` BEFORE the seed+ping so a subscriber that reads
    // during a ping sees the complete post-genesis list.
    this.listCache = null;
    const now = Date.now();
    for (const record of records) {
      this.view.seedSync(seededSkill(record, now), { ping: true });
    }
  }

  /**
   * Run the source hydrator with the derived genesis ctx, wrapping any throw in
   * the typed {@link SkillsHydrateFailed}. Shared by genesis, `reload()`, and
   * `resolve()` — one source, one failure shape.
   */
  private async runHydrator(): Promise<readonly SkillSeed[]> {
    const hydrate = this.hydrator;
    if (hydrate === undefined) return [];
    try {
      return await hydrate(this.hydrateCtx());
    } catch (cause) {
      throw cause instanceof SkillsHydrateFailed ? cause : new SkillsHydrateFailed({ cause });
    }
  }

  /**
   * Derive the ctx handed to the genesis hydrator (ADR 91/93).
   *
   * Minted through `deriveOperationCtx` — the branded boundary constructor — so
   * the hydrator sees the session's identity (`sessionId`, `principal`) and
   * diagnostics (`log`/`trace`/`metrics`/`run`) rather than nothing, plus two
   * boundary facets composed INTO the same branded mint: the definition's `store`
   * (the typed `ctx.store` facet) and the journal's READ slice
   * (`journalReader`), which is what makes an event-sourced hydrator writable
   * with no framework change.
   *
   * `ctx.principal` is the TIERED-CATALOG seam — a hydrator returning a different
   * skill set per owner is a plain function of this ctx.
   *
   * The result is also a valid `StoreCtx`, so `hydrateFromStore` hands `ctx`
   * straight to `store.query(undefined, ctx)` with no repacking.
   */
  private hydrateCtx(): SkillsHydrateCtx {
    return this.deriveOperationCtx(
      { sessionId: this.scopeId },
      {
        store: this.store,
        journalReader: this.journal,
        ...(this.principal !== undefined ? { principal: this.principal } : {}),
      },
    ) as SkillsHydrateCtx;
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
