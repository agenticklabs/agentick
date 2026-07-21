/**
 * `PromptsHarness` — durable parameterized prompt library.
 *
 * Per ADR 32, Shape 1 harness:
 *   - Audit envelopes for every register / update / remove / invoke
 *   - Snapshot/restore via `SnapshotCapable` (declarations only —
 *     `template` and `render` aren't serializable; adopter
 *     re-registers content alongside snapshot load)
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * **Invocation (ADR 51)** — every verb is a DECLARED COMMAND
 * (constructor, `this.command()`): `prompts:register`, `prompts:update`,
 * `prompts:remove`, `prompts:invoke`, and `prompts:get`. One canonical
 * string per verb is simultaneously the inbox message type over
 * `prompts:{scopeId}`, the op-name root, the authz scope label, and the
 * (matrix-gated) wire method name. Cross-boundary payloads carry
 * serializable declarations only (`template` as data); the optional
 * `render` fn is an in-process convenience that never travels.
 *
 * Renderer dispatch:
 *   - `string` content → `stringToSystemMessage` (built-in)
 *   - `readonly MessageEntry[]` content → passthrough (built-in)
 *   - Anything else → first matching `PromptRenderer` from the
 *     registered array (`opts.renderers` at construction). Framework
 *     bindings ship their own renderer + convenience extension.
 *
 * `invoke()` queues to the session timeline via `bridges.timeline.queue`
 * (same channel as explicit user input). `get()` renders without
 * queueing for external consumers (MCP server `prompts/get`, snapshot
 * tests, doc generators).
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see packages-next/spec/src/protocol/prompts-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  CollectionMutation,
  EventBus,
  MessageEntry,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  PromptArgument,
  PromptDeclaration,
  PromptDeclarationRecord,
  PromptStoreQuery,
  PromptsError,
  PromptsGetInput,
  PromptsGetResult,
  PromptsHarnessProtocol,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsSnapshotEntry,
  PromptsUpdateInput,
  Store,
  StandardSchemaIssue,
  StandardSchemaV1,
  TimelineHarnessProtocol,
} from "@agentick/spec-next";
import {
  HandlerError,
  PromptAlreadyExists,
  PromptArgumentInvalid,
  PromptArgumentMissing,
  PromptMissingContent,
  PromptNotFound,
  PromptRenderFailed,
  PromptsBackendError,
} from "@agentick/spec-next";
import { View } from "@agentick/store-next";
import { omitUndefined, ulid } from "@agentick/utils-next";

import type { PromptLoader } from "./loaders.js";
import { isMessageEntryArray, stringToSystemMessage, type PromptRenderer } from "./renderer.js";
import { InMemoryPromptStore } from "./store.js";

/**
 * The NON-serializable runtime augmentation of a prompt — the two fields the
 * store slice ({@link PromptDeclarationRecord}) drops. Held in a parallel
 * harness-local sidecar keyed by name (never persisted): a `render` fn is
 * closure-bound and a `template` may be a live framework node. Re-attached at
 * `register`/`update`; the full {@link PromptDeclaration} is the record COMBINED
 * with this. On restore the sidecar starts empty — the adopter re-registers
 * content alongside snapshot load.
 */
type PromptAugmentation = Pick<PromptDeclaration, "template" | "render">;

const SURFACE = "prompts" as const;
type PromptsSurface = typeof SURFACE;

export interface PromptsHarnessOptions {
  /**
   * Renderers for non-native content shapes (anything other than
   * `string` and `MessageEntry[]`). Framework bindings (e.g.
   * `@agentick/prompts-react-next`) ship their own. First-match-wins
   * on `renderer.handles(content)`.
   */
  readonly renderers?: readonly PromptRenderer[];
  /**
   * Source of the session's `bridges.timeline` for `invoke()` queue
   * injection. Injected at construction by the extension installer.
   * When absent, `invoke()` skips queueing (renders + returns the
   * messages exactly like `get()` does).
   */
  readonly timeline?: TimelineHarnessProtocol;
  /**
   * Durable backing for the prompt RECORD slice (data-layer plan §6-C, Phase 5).
   * Defaults to a fresh per-harness in-memory {@link InMemoryPromptStore}. The
   * store holds ONLY the serializable {@link PromptDeclarationRecord} — the
   * `template`/`render` augmentation stays in the harness's sidecar and never
   * reaches the store. It is the durable truth; the synchronous
   * {@link View} is its sync read cache (reads never touch the store).
   * Injecting a durable adapter is how prompt declarations survive process
   * restart; `hydrate()` loads them back into the view. Typed against the
   * `Store` SEAM — a durable adapter need only implement `query`/`mutate`.
   * The sidecar does NOT survive — the adopter re-registers `render`/`template`
   * alongside restore (fns aren't serializable).
   *
   * A view (not async-through-the-store): prompts carries a SYNC
   * `exportSnapshot()` (the generic `captureBridgeSnapshots` calls it un-awaited,
   * SnapshotCapable) AND a sync `getDeclaration`/`has`/`list` surface — both are
   * load-bearing sync callers, so a synchronous materialized view is required.
   */
  readonly store?: Store<
    PromptDeclarationRecord,
    PromptStoreQuery,
    CollectionMutation<PromptDeclarationRecord>
  >;
}

export class PromptsHarness extends BaseHarness<PromptsSurface> implements PromptsHarnessProtocol {
  /**
   * The synchronous {@link View} of the prompt store (data-layer plan
   * §3.5 P5) — ONE primitive that collapses the two fields this used to
   * hand-roll (a `CollectionProjection` for the sync cache + write-through and a
   * `KeyedNotifier` for render pings). Holds the SERIALIZABLE
   * {@link PromptDeclarationRecord} slice. `getDeclaration` / `has` / `list` read
   * it during render; `exportSnapshot` materializes it synchronously (records ARE
   * the snapshot — fns are excluded by construction); the mutation helpers write
   * through it (sync cache first, durable store off the critical path via the
   * `query`/`mutate` seam) and each single write pings the key. The record slice
   * is a pure-mirror collection (cache value IS the stored record), so the view
   * fits without refinement; the non-serializable `{ template, render }`
   * augmentation lives in the parallel {@link augmentations} sidecar the view is
   * agnostic to. Keyed by record `name`. No `onChange` subscriber — prompts has
   * no client-facing change channel.
   */
  private readonly view: View<
    PromptDeclarationRecord,
    PromptDeclarationRecord,
    PromptStoreQuery,
    CollectionMutation<PromptDeclarationRecord>
  >;
  /**
   * The NON-serializable augmentation sidecar (data-layer plan §6-C — the
   * "augmented instance" split). Parallel to {@link view}, keyed by the SAME
   * `name`. Holds `{ template?, render? }` — written at register/update, dropped
   * at remove, CLEARED on `importSnapshot` (fns can't survive serialization; the
   * adopter re-registers). NEVER written to the store — the
   * `PromptDeclarationRecord` type makes that a compile-time guarantee, and the
   * {@link View} never touches it (it mirrors the record slice only).
   * Only entries with a defined `template` or `render` are kept (see
   * {@link setAugmentation}).
   */
  private readonly augmentations = new Map<string, PromptAugmentation>();
  private readonly renderers: readonly PromptRenderer[];
  private readonly timeline?: TimelineHarnessProtocol;

  /**
   * Loaders retained from `withPrompts({ loaders })`. Drive
   * post-startup `reload()` + lookup-on-miss in `invoke()` / `get()`.
   */
  private loaders: readonly PromptLoader[] = [];

  /** Cached snapshot for `list()`. Invalidated on every mutation. */
  private listCache: readonly PromptDeclaration[] | null = null;

  /**
   * Declared commands (ADR 51) — pure layer logic in the bodies; the
   * registry owns construction, inbox routing, and enumeration.
   *
   * `invoke` renders + queues onto the session timeline (via
   * `bridges.timeline.queue`, same channel as explicit user input);
   * `get` renders without queueing (MCP `prompts/get`, snapshot tests,
   * doc generators). Both perform lookup-on-miss against configured
   * loaders inside the command body, so inbox-delivered invocations
   * resolve lazily exactly like in-process calls.
   */
  readonly register: (input: PromptsRegisterInput) => Promise<PromptDeclaration>;
  readonly update: (input: PromptsUpdateInput) => Promise<PromptDeclaration>;
  readonly remove: (input: PromptsRemoveInput) => Promise<void>;
  readonly invoke: (input: PromptsInvokeInput) => Promise<PromptsGetResult>;
  readonly get: (input: PromptsGetInput) => Promise<PromptsGetResult>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: PromptsHarnessOptions = {},
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    this.renderers = options.renderers ?? [];
    this.timeline = options.timeline;
    this.view = View.collection(options.store ?? new InMemoryPromptStore(), (r) => r.name);

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming, and enumeration
    // all derive from these; the pre-registry `handleMessage` switch is
    // gone. Payloads carried no validation before the registry; schemas
    // stay off for parity. The optional `render` fn on register/update
    // declarations is in-process-only convenience (ADR 51 §1.2 excludes
    // ops with REQUIRED function parameters; the addressable form
    // carries `template` data — same precedent as `knobs:register`'s
    // optional `validate`).
    const scope = () => ({ sessionId: this.scopeId });
    this.register = this.command({
      name: "prompts:register",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: PromptsRegisterInput) => this.applyRegister(i),
    });
    this.update = this.command({
      name: "prompts:update",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: PromptsUpdateInput) => this.applyUpdate(i),
    });
    this.remove = this.command({
      name: "prompts:remove",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: PromptsRemoveInput) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
    });
    this.invoke = this.command({
      name: "prompts:invoke",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: PromptsInvokeInput) => this.applyInvoke(i),
    });
    this.get = this.command({
      name: "prompts:get",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: PromptsGetInput) => this.applyGet(i),
    });
  }

  /**
   * Replace the loader set used by `reload()` and the lookup-on-miss
   * fallback in `invoke()` / `get()`. Called by `withPrompts` at
   * install time; adopters can also swap the loader set at runtime.
   */
  setLoaders(loaders: readonly PromptLoader[]): void {
    this.loaders = loaders;
  }

  // ─────────── Dynamic surface ───────────

  /**
   * Re-run every configured loader, diff against current state, apply
   * adds + updates (and removes when `pruneMissing: true`). Returns
   * a summary of names touched.
   *
   * **Caveat:** the diff only looks at registered prompts; loaded
   * prompts that lack `template` and `render` are still passed through
   * to `register` (the harness will reject at `register` time if the
   * declaration is malformed).
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    const batches = await Promise.all(this.loaders.map((l) => l.load()));
    const fresh = new Map<string, PromptDeclaration>();
    for (const batch of batches) {
      for (const input of batch) fresh.set(input.declaration.name, input.declaration);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const [name, decl] of fresh) {
      if (this.view.hasSync(name)) {
        await this.update({
          name,
          declaration: {
            description: decl.description,
            ...(decl.arguments ? { arguments: decl.arguments } : {}),
            ...(decl.template !== undefined ? { template: decl.template } : {}),
            ...(decl.render !== undefined ? { render: decl.render } : {}),
            ...(decl.metadata ? { metadata: decl.metadata } : {}),
          },
        });
        updated.push(name);
      } else {
        await this.register({ declaration: decl });
        added.push(name);
      }
    }
    const removed: string[] = [];
    if (opts.pruneMissing) {
      for (const name of this.view.listSync().map((r) => r.name)) {
        if (!fresh.has(name)) {
          await this.remove({ name });
          removed.push(name);
        }
      }
    }
    return { added, updated, removed };
  }

  /**
   * Lookup-on-miss internal helper used by `invoke()` / `get()` and
   * by the public `resolve()`. Returns the registered prompt if
   * present; otherwise asks each loader (via `lookup` or `load()` +
   * filter). On hit, registers + returns the declaration. `null` if
   * no loader has the name.
   */
  async resolve(name: string): Promise<PromptDeclaration | null> {
    const existing = this.declarationOf(name);
    if (existing) return existing;
    for (const loader of this.loaders) {
      const found = loader.lookup
        ? await loader.lookup(name)
        : ((await loader.load()).find((p) => p.declaration.name === name) ?? null);
      if (found) {
        await this.register(found);
        return this.declarationOf(name) ?? null;
      }
    }
    return null;
  }

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `PromptNotFound`-tagged error instead of returning `null` when
   * no loader has the name. Use when the absence of a name is a
   * programming error (must-exist contract). For "render this prompt"
   * use `invoke()` instead — it already throws PromptNotFound on miss.
   */
  async require(name: string): Promise<PromptDeclaration> {
    const resolved = await this.resolve(name);
    if (resolved !== null) return resolved;
    throw new PromptNotFound({ name });
  }

  // ─────────── Sync surface ───────────

  /**
   * COMBINE the two halves back into a full {@link PromptDeclaration}: the
   * serializable record from the {@link projection} + the non-serializable
   * `{ template, render }` from the {@link augmentations} sidecar. The single
   * site the split is re-joined — every read that hands out a full declaration
   * (`getDeclaration`, `list`, `resolve`, render) goes through here.
   * `undefined` when the record is absent (an orphan sidecar entry — which
   * cannot occur, they are written and dropped together — would be ignored).
   */
  private declarationOf(name: string): PromptDeclaration | undefined {
    const record = this.view.getSync(name);
    if (!record) return undefined;
    const aug = this.augmentations.get(name);
    return aug ? { ...record, ...aug } : record;
  }

  getDeclaration(name: string): PromptDeclaration | undefined {
    return this.declarationOf(name);
  }

  has(name: string): boolean {
    return this.view.hasSync(name);
  }

  list(): readonly PromptDeclaration[] {
    if (this.listCache !== null) return this.listCache;
    const out = this.view.listSync().map((r) => this.declarationOf(r.name)!);
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.listCache = out;
    return out;
  }

  subscribe(name: string, listener: () => void): Unsubscribe {
    return this.view.subscribe(name, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.view.subscribeAll(listener);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, PromptsSnapshotEntry>> {
    // Reads the sync view cache — MUST stay synchronous: the generic
    // `captureBridgeSnapshots` invokes this un-awaited (SnapshotCapable). The
    // view holds ONLY records (a `PromptsSnapshotEntry` IS a record), so the
    // augmentation is dropped by construction — no per-field stripping.
    const out: Record<string, PromptsSnapshotEntry> = {};
    for (const record of this.view.listSync()) out[record.name] = record;
    return out;
  }

  importSnapshot(snapshot: Readonly<Record<string, PromptsSnapshotEntry>>): void {
    // Wholesale replace via the view: keys absent from the snapshot are dropped
    // from BOTH the cache and the store; each snapshot record writes through. The
    // view mutates the whole cache FIRST then batch-pings the union (drops ∪
    // upserts), so invalidate `listCache` BEFORE `replace`. `replace` is
    // change-SILENT (prompts has no per-key change channel). NOTE: the old
    // `notifier.notifyAll()` fired the wildcard once; `replace` pings each touched
    // key — the keyed bucket AND the wildcard per key — a superset, never fewer.
    //
    // The augmentation sidecar is CLEARED — `template`/`render` are
    // non-serializable, so a restored prompt has no content until the adopter
    // re-registers it (invoke/get then throw `PromptMissingContent` until they do).
    // The `View` is agnostic to the sidecar; the clear is harness-owned.
    //
    // TODO(store-phase-4): `importSnapshot` is the ACTIVE snapshot-based resume
    // path. The Phase-4 manifest sweep replaces it with `hydrate()` once the
    // store is the authority. Do NOT wire `hydrate()` into resume while this
    // method still owns it.
    this.listCache = null;
    this.view.replace(Object.values(snapshot), this.storeCtx());
    this.augmentations.clear();
  }

  /**
   * Load the durable store into the sync view — the future manifest resume
   * path (data-layer plan Phase 4). A MERGE (store records overlay the view),
   * not a clear-first replace — a fresh session's store is empty ⇒ a no-op. The
   * augmentation sidecar is NOT touched: records survive the store,
   * `template`/`render` do not, so a hydrated prompt has record-only content
   * until re-registered. Invalidates `list()`; the view pings each hydrated key.
   *
   * NOT wired into session resume in this run: `importSnapshot` remains the
   * active resume path. `hydrate()` is the seam the Phase-4 manifest sweep flips
   * to once the store is authority.
   */
  async hydrate(): Promise<void> {
    // The view merges the store projection into the cache and pings each loaded
    // key. Invalidate `listCache` BEFORE the merge+ping so a subscriber re-reads
    // the hydrated list. The sidecar is left untouched (parity).
    this.listCache = null;
    await this.view.hydrate(undefined, this.storeCtx());
  }

  // ─────────── Inbox routing ───────────

  /**
   * `prompts:register/update/remove/invoke/get` are declared commands —
   * routed by the BaseHarness command registry before this fallthrough.
   * Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown prompts message type: ${msg.type}` }));
  }

  // ─────────── Private mutation + invoke ───────────

  private applyRegister(
    input: PromptsRegisterInput,
  ): Effect.Effect<PromptDeclaration, PromptsError, never> {
    return Effect.suspend((): Effect.Effect<PromptDeclaration, PromptsError, never> => {
      const decl = input.declaration;
      if (this.view.hasSync(decl.name)) {
        return Effect.fail(new PromptAlreadyExists({ name: decl.name }));
      }
      // Split: the serializable record writes through the view (sync cache first,
      // durable store off the critical path, a render ping); the non-serializable
      // `{ template, render }` re-attaches to the sidecar, never the store.
      // Invalidate `listCache` and populate the sidecar BEFORE the view write so a
      // subscriber that reads during the write's synchronous ping sees BOTH the
      // fresh list and the combined declaration (the sidecar-merged view).
      const record: PromptDeclarationRecord = {
        name: decl.name,
        description: decl.description,
        ...omitUndefined({ arguments: decl.arguments, metadata: decl.metadata }),
      };
      this.listCache = null;
      this.setAugmentation(decl.name, decl);
      this.view.write(record, this.storeCtx());
      return Effect.succeed(this.declarationOf(decl.name)!);
    });
  }

  private applyUpdate(
    input: PromptsUpdateInput,
  ): Effect.Effect<PromptDeclaration, PromptsError, never> {
    return Effect.suspend((): Effect.Effect<PromptDeclaration, PromptsError, never> => {
      const existingRecord = this.view.getSync(input.name);
      if (!existingRecord) {
        return Effect.fail(new PromptNotFound({ name: input.name }));
      }
      const existingAug = this.augmentations.get(input.name);
      const patch = input.declaration;
      const updatedRecord: PromptDeclarationRecord = {
        name: input.name,
        description: patch.description ?? existingRecord.description,
        ...omitUndefined({
          arguments: patch.arguments ?? existingRecord.arguments,
          metadata: patch.metadata ?? existingRecord.metadata,
        }),
      };
      // Invalidate `listCache` and merge the sidecar BEFORE the view write so a
      // subscriber reading during the write's synchronous ping sees the combined
      // declaration. Merge: incoming `template`/`render` win; absent → keep the
      // existing sidecar value (same `??` merge the record fields use).
      this.listCache = null;
      this.setAugmentation(input.name, {
        template: patch.template ?? existingAug?.template,
        render: patch.render ?? existingAug?.render,
      });
      this.view.write(updatedRecord, this.storeCtx());
      return Effect.succeed(this.declarationOf(input.name)!);
    });
  }

  private applyRemove(input: PromptsRemoveInput): void {
    // Idempotent — the view's `deleteSync` fires nothing on an absent name. The
    // `hasSync` guard keeps the `listCache`/sidecar mutations off the no-op path.
    // Drop the sidecar and invalidate BEFORE the view delete so a subscriber
    // reading during the ping sees the entry fully gone.
    if (this.view.hasSync(input.name)) {
      this.listCache = null;
      this.augmentations.delete(input.name);
      this.view.deleteSync(input.name, this.storeCtx());
    }
  }

  /**
   * Store the `{ template, render }` augmentation for `name`, keeping ONLY
   * defined fields. When neither is present the sidecar entry is DROPPED (rather
   * than a `{}` kept) so `declarationOf` never spreads an empty object and
   * `has`/`list` stay driven purely by the record projection.
   */
  private setAugmentation(name: string, source: PromptAugmentation): void {
    const aug: { -readonly [K in keyof PromptAugmentation]: PromptAugmentation[K] } = {};
    if (source.template !== undefined) aug.template = source.template;
    if (source.render !== undefined) aug.render = source.render;
    if (aug.template !== undefined || aug.render !== undefined) {
      this.augmentations.set(name, aug);
    } else {
      this.augmentations.delete(name);
    }
  }

  private applyInvoke(
    input: PromptsInvokeInput,
  ): Effect.Effect<PromptsGetResult, PromptsError, never> {
    return Effect.tryPromise({
      try: async () => {
        // Lookup-on-miss: if the name isn't yet registered, ask
        // configured loaders. On hit, the prompt is registered (a
        // nested `prompts:register` command) + invoke proceeds; on
        // miss, `renderToMessages` throws `PromptNotFound`.
        if (!this.view.hasSync(input.name) && this.loaders.length > 0) {
          await this.resolve(input.name);
        }
        const result = await this.renderToMessages(input.name, input.args);
        // Append the rendered messages directly to the session timeline
        // (ADR 53 — input appends the moment it exists; no queue/drain
        // tier). The next render sees them via <Timeline/>. When no
        // timeline is wired (e.g., test setup without session), skip —
        // adopters use `get()` for that path.
        if (this.timeline) {
          const ts = Date.now();
          for (const msg of result.messages) {
            await this.timeline.append({
              kind: "message",
              message: {
                id: `m_${ulid()}`,
                role: msg.role,
                content: msg.content,
                ts,
                ...omitUndefined({ metadata: msg.metadata }),
              },
            });
          }
        }
        return result;
      },
      catch: (cause): PromptsError =>
        isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
    });
  }

  private applyGet(input: PromptsGetInput): Effect.Effect<PromptsGetResult, PromptsError, never> {
    return Effect.tryPromise({
      try: async () => {
        // Same lookup-on-miss path as `applyInvoke`.
        if (!this.view.hasSync(input.name) && this.loaders.length > 0) {
          await this.resolve(input.name);
        }
        return this.renderToMessages(input.name, input.args);
      },
      catch: (cause): PromptsError =>
        isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
    });
  }

  private async renderToMessages(
    name: string,
    rawArgs: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PromptsGetResult> {
    const decl = this.declarationOf(name);
    if (!decl) throw new PromptNotFound({ name });

    // 1. Validate args against the declared schemas.
    const args = await validateArgs(name, decl.arguments, rawArgs ?? {});

    // 2. Resolve the content — `render(args)` wins; fall back to `template`.
    let content: unknown;
    if (decl.render) {
      try {
        content = await Promise.resolve(decl.render(args));
      } catch (cause) {
        throw new PromptRenderFailed({ name, cause });
      }
    } else if (decl.template !== undefined) {
      content = decl.template;
    } else {
      throw new PromptMissingContent({ name });
    }

    // 3. Dispatch to native handler or matching renderer.
    const messages = await this.dispatchContent(name, content, args);

    return { description: decl.description, messages };
  }

  private async dispatchContent(
    name: string,
    content: unknown,
    args: Readonly<Record<string, unknown>>,
  ): Promise<readonly MessageEntry[]> {
    if (typeof content === "string") {
      return [stringToSystemMessage(content)];
    }
    if (isMessageEntryArray(content)) {
      return content;
    }
    for (const renderer of this.renderers) {
      if (renderer.handles(content)) {
        try {
          return await renderer.render(content, args);
        } catch (cause) {
          throw new PromptRenderFailed({ name, cause });
        }
      }
    }
    throw new PromptRenderFailed({
      name,
      cause: `no registered renderer handles content (typeof=${typeof content}); registered: [${this.renderers.map((r) => r.name).join(", ")}]`,
    });
  }
}

// ─────────── Argument validation ───────────

async function validateArgs(
  promptName: string,
  argDecls: readonly PromptArgument[] | undefined,
  raw: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  if (!argDecls || argDecls.length === 0) return raw;
  const validated: Record<string, unknown> = {};
  for (const arg of argDecls) {
    const value = raw[arg.name];
    if (value === undefined) {
      if (arg.required === true) {
        throw new PromptArgumentMissing({
          name: promptName,
          argument: arg.name,
        }) satisfies PromptsError;
      }
      continue;
    }
    if (arg.schema) {
      const result = await runStandardSchema(arg.schema, value);
      if (result.issues) {
        throw new PromptArgumentInvalid({
          name: promptName,
          argument: arg.name,
          issues: result.issues.map((iss) => ({
            ...omitUndefined({ path: iss.path?.map(coercePathSegment) }),
            message: iss.message,
          })),
        });
      }
      validated[arg.name] = result.value;
    } else {
      validated[arg.name] = value;
    }
  }
  // Pass through any unknown args (not declared) — adopter choice
  // whether they care about extras; harness doesn't reject.
  for (const key of Object.keys(raw)) {
    if (!(key in validated) && !argDecls.some((a) => a.name === key)) {
      validated[key] = raw[key];
    }
  }
  return validated;
}

async function runStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<
  | { value: unknown; issues?: undefined }
  | { value?: undefined; issues: readonly StandardSchemaIssue[] }
> {
  const result = await Promise.resolve(schema["~standard"].validate(value));
  if ("issues" in result && result.issues) {
    return { issues: result.issues };
  }
  return { value: (result as { value: unknown }).value };
}

function coercePathSegment(seg: PropertyKey | { readonly key: PropertyKey }): string | number {
  const key = typeof seg === "object" && seg !== null && "key" in seg ? seg.key : seg;
  if (typeof key === "number") return key;
  return String(key);
}

const PROMPTS_ERROR_TAGS = [
  "PromptNotFound",
  "PromptAlreadyExists",
  "PromptArgumentMissing",
  "PromptArgumentInvalid",
  "PromptMissingContent",
  "PromptRenderFailed",
  "PromptsBackendError",
] as const;

function isPromptsError(value: unknown): value is PromptsError {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  if (typeof tag !== "string") return false;
  return (PROMPTS_ERROR_TAGS as readonly string[]).includes(tag);
}
