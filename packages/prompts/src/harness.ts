/**
 * `PromptsHarness` — durable parameterized prompt library.
 *
 * Per ADR 32, Shape 1 harness:
 *   - Audit envelopes for every register / update / remove / invoke
 *   - Snapshot/restore via `SnapshotCapable` (declarations only —
 *     `template`, `render`, and an argument's inline `complete`
 *     resolver aren't serializable; adopter re-registers content
 *     alongside snapshot load)
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * **Invocation (ADR 51)** — every verb is a DECLARED COMMAND
 * (constructor, `this.command()`): `prompts:register`, `prompts:update`,
 * `prompts:remove`, `prompts:invoke`, `prompts:render` (the render),
 * `prompts:get` (the declaration read), and `prompts:list`. One canonical
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
 * `invoke()` APPENDS the rendered messages to the session timeline (ADR 53
 * — input appends the moment it exists), each entry STAMPED with its
 * materialization provenance at `metadata.source.prompt` so a projection can
 * tell a rendered prompt from typed user input. `render()` renders without
 * appending, for external consumers (MCP server `prompts/get`, snapshot
 * tests, doc generators), and stamps nothing — nothing entered the
 * timeline; `get(name)` is the sync declaration read.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see packages/spec/src/protocol/prompts-harness.ts
 */

import { Effect } from "effect";
import {
  BaseHarness,
  getBoundaryFacets,
  type BaseHarnessOptions,
  type Unsubscribe,
} from "@agentick/runtime";
import type {
  CollectionMutation,
  CompletionCtx,
  CompletionResolver,
  CompletionsErrorChannel,
  Elicit,
  EventBus,
  MessageEntry,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  PromptArgument,
  PromptDeclaration,
  PromptDeclarationRecord,
  PromptRenderCtx,
  PromptStoreQuery,
  PromptsCompleteInput,
  PromptsCompleteOutcome,
  PromptsError,
  PromptsErrorChannel,
  PromptsFx,
  PromptsGetInput,
  PromptsGetResult,
  PromptsHarnessProtocol,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsSnapshotEntry,
  PromptsUpdateInput,
  StandardSchemaIssue,
  StandardSchemaV1,
  TimelineHarnessProtocol,
} from "@agentick/spec";
import {
  CompletionResolveFailed,
  HandlerError,
  PromptAlreadyExists,
  PromptArgumentInvalid,
  PromptArgumentMissing,
  PromptMissingContent,
  PromptNotFound,
  PromptRenderFailed,
  PromptsBackendError,
  PromptsHydrateFailed,
} from "@agentick/spec";
import { View } from "@agentick/store";
import { omitUndefined, paginate, generateId } from "@agentick/utils";

import type { PromptMessageSource } from "./message-source.js";
import {
  foldCompletionValues,
  normalizePromptArguments,
  promptCompletionRef,
  restorePromptArguments,
  type NormalizedPromptArguments,
} from "./completion.js";
import type {
  PromptSeed,
  PromptsDefinition,
  PromptsHydrateCtx,
  PromptsHydrator,
  PromptsStore,
} from "./definition.js";
import { isMessageEntryArray, stringToSystemMessage, type PromptRenderer } from "./renderer.js";
import { InMemoryPromptStore } from "./store.js";
import type { PromptsListInput, PromptsListResult } from "./wire-augment.js";

/**
 * The NON-serializable runtime augmentation of a prompt — the fields the store
 * slice ({@link PromptDeclarationRecord}) drops. Held in a parallel harness-local
 * sidecar keyed by name (never persisted): a `render` fn is closure-bound, a
 * `template` may be a live framework node, and a per-argument completion
 * resolver is a closure over whatever data source answers it. Re-attached at
 * `register`/`update`; the full {@link PromptDeclaration} is the record COMBINED
 * with this. On restore the sidecar starts empty — the adopter re-registers
 * content alongside snapshot load.
 */
type PromptAugmentation = Pick<PromptDeclaration, "template" | "render"> & {
  /**
   * Inline {@link CompletionResolver}s from `arguments[].complete`, keyed by
   * ARGUMENT name (the record's `completeRef` holds each one's derived registry
   * name). Same ride `render` takes, for the same reason.
   */
  readonly completions?: Readonly<Record<string, CompletionResolver>>;
};

const SURFACE = "prompts" as const;
type PromptsSurface = typeof SURFACE;

// ADR 80/83 — type the prompts verbs on the command registry. This is what mints
// `onBeforePromptsRegister` / `onAfterPromptsInvoke` (and the `guards:
// { promptsInvoke }` key) on the app-level derived surfaces, and — via the
// drop-layer projections — `NamespaceHooks<"prompts">` /
// `NamespaceGuards<"prompts">` for the definition's own bags. Without these rows
// both bags are the empty object and the sugar advertises nothing.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "prompts:register": { input: PromptsRegisterInput; output: PromptDeclaration };
    "prompts:update": { input: PromptsUpdateInput; output: PromptDeclaration };
    "prompts:remove": { input: PromptsRemoveInput; output: void };
    "prompts:invoke": { input: PromptsInvokeInput; output: PromptsGetResult };
    "prompts:render": { input: PromptsGetInput; output: PromptsGetResult };
    "prompts:get": { input: { readonly name: string }; output: PromptDeclaration | null };
    "prompts:list": { input: PromptsListInput; output: PromptsListResult };
  }
}

/**
 * The one capability `invoke()` needs from the session's timeline — appending an
 * entry. Least-privilege injection (the `bindRunner(send: SessionSendCapability)`
 * precedent in `@agentick/skills`): prompts materializes INTO the timeline, it
 * never reads, filters, or snapshots it, so the whole harness is more than the
 * seam requires. A real `TimelineHarnessProtocol` satisfies it structurally.
 */
export type TimelineAppendCapability = Pick<TimelineHarnessProtocol, "append">;

/**
 * How the host supplies {@link TimelineAppendCapability} — a value OR a
 * PROVIDER read at append time.
 *
 * The provider arm exists because of an ordering fact the value arm cannot
 * express: session extensions install BEFORE the session (and therefore before
 * its `bridges.timeline`) exists, so an installer that resolves the timeline
 * eagerly resolves `undefined` — permanently, for the whole session. The
 * extension passes `() => installer.getNamespace("timeline")`; the app
 * publishes the host timeline into that same namespace map once the session is
 * constructed; the first `invoke()` reads through and finds it.
 *
 * A provider that returns `undefined` is retried on the NEXT invoke — a
 * timeline that appears later starts working, and a miss is never cached.
 *
 * @verifiedBy packages/prompts/src/__tests__/timeline-late-binding.spec.ts
 * @verifiedBy packages/app/src/__tests__/prompts-invoke-timeline.spec.tsx
 */
export type TimelineAppendSource =
  | TimelineAppendCapability
  | (() => TimelineAppendCapability | undefined);

/**
 * How the host supplies the {@link Elicit} a render may ask through — a value OR
 * a PROVIDER read at render time, for the same ordering reason as
 * {@link TimelineAppendSource}: the session that owns the elicitation harness is
 * born after the extension that wants it installs.
 *
 * Why the host hands over a BUILT `Elicit` rather than the elicitation harness:
 * `Elicit` is a spec type, so prompts types the facet without depending on
 * `@agentick/elicitation` at runtime. Building the sugar here would put a hard
 * dependency on the elicitation package into every deployment that registers a
 * prompt — for a facet most prompts never touch. The app already holds both
 * (`session.elicit` IS this value) and is the one place that can hand it over
 * for free.
 *
 * @verifiedBy packages/prompts/src/__tests__/render-elicit.spec.ts
 */
export type ElicitSource = Elicit | (() => Elicit | undefined);

/**
 * Construction options for {@link PromptsHarness} — the {@link PromptsDefinition}
 * (store · genesis · shaping seams · `hooks:` / `guards:`) plus the
 * {@link BaseHarnessOptions} the substrate needs (journaling policy, the
 * interceptor-inheritance handle) and the host-injected `timeline`.
 *
 * There is ONE options shape: `withPrompts(...)`, `createApp({ prompts })`, and
 * this constructor all take the same definition.
 */
export interface PromptsHarnessOptions
  extends BaseHarnessOptions<unknown, "prompts">, PromptsDefinition {
  /**
   * Source of the session's `bridges.timeline` for `invoke()` append. Injected at
   * construction by the extension installer, NOT part of the adopter-facing
   * definition — when absent, `invoke()` renders and returns without appending
   * (exactly what `render()` does).
   *
   * Takes a live capability (the direct-injection path: tests, a BYO harness) or
   * a PROVIDER resolved at append time (what `withPrompts` passes — see
   * {@link TimelineAppendSource} for why the eager read cannot work).
   */
  readonly timeline?: TimelineAppendSource;
  /**
   * Source of the {@link Elicit} threaded onto the render ctx as `ctx.elicit`,
   * so a declaration can ask the user for what the invoke did not supply.
   * Injected at construction by the extension installer exactly like
   * {@link timeline}, NOT part of the adopter-facing definition — when absent,
   * `ctx.elicit` is `undefined` and the declaration takes its no-elicit branch.
   *
   * Takes a live `Elicit` (the direct-injection path: tests, a BYO wiring) or a
   * PROVIDER resolved at render time (what `withPrompts` passes).
   */
  readonly elicit?: ElicitSource;
}

export class PromptsHarness extends BaseHarness<PromptsSurface> implements PromptsHarnessProtocol {
  /**
   * The synchronous {@link View} of the prompt store (data-layer plan
   * §3.5 P5) — ONE primitive that collapses the two fields this used to
   * hand-roll (a `CollectionProjection` for the sync cache + write-through and a
   * `KeyedNotifier` for render pings). Holds the SERIALIZABLE
   * {@link PromptDeclarationRecord} slice. `get` / `has` / `list` read
   * it during render; `exportSnapshot` materializes it synchronously (records ARE
   * the snapshot — fns are excluded by construction); the mutation helpers write
   * through it (sync cache first, durable store off the critical path via the
   * `query`/`mutate` seam) and each single write pings the key. The record slice
   * is a pure-mirror collection (cache value IS the stored record), so the view
   * fits without refinement; the non-serializable `{ template, render,
   * completions }` augmentation lives in the parallel {@link augmentations} sidecar the view is
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
  /** Value or provider — resolved per append by {@link resolveTimeline}. */
  private readonly timelineSource?: TimelineAppendSource;
  /** Provider result, cached on the first HIT only (a miss must re-resolve). */
  private resolvedTimeline?: TimelineAppendCapability;
  /** Value or provider — resolved per render by {@link resolveElicit}. */
  private readonly elicitSource?: ElicitSource;
  /** Provider result, cached on the first HIT only (a miss must re-resolve). */
  private resolvedElicit?: Elicit;
  /** Latch for the once-per-harness "no timeline wired" warning. */
  private warnedNoTimeline = false;

  /**
   * The definition's own store — held so the genesis ctx can hand it to a
   * hydrator as the typed `ctx.store` facet.
   */
  private readonly store: PromptsStore;

  /**
   * The GENESIS seam (ADR 93), resolved at construction from the definition's
   * `hydrate` slot. **No default** — a configured `store` does not imply a store
   * read. `undefined` means the catalog opens empty.
   *
   * It is also THE source `reload()` and the `invoke()` / `render()`
   * lookup-on-miss re-run — the source unification (ADR 93 rendered-moot #3)
   * collapsed the old `loaders: []` array and `initial: []` bag into this seam.
   */
  private hydrator?: PromptsHydrator;

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
  /** `prompts:render` — render a prompt to messages WITHOUT queueing. */
  readonly render: (input: PromptsGetInput) => Promise<PromptsGetResult>;

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
    // Thread the substrate options through — journaling policy AND the
    // interceptor-inheritance handle (ADR 93 landmine 11). Without the latter an
    // extension-installed prompts harness is INVISIBLE to `app.guard()` /
    // `createApp({ hooks, guards })`, which becomes a correctness bug the moment
    // the definition advertises its own `hooks:` / `guards:` bags.
    super(SURFACE, scopeId, journal, bus, inbox, options);
    this.renderers = options.renderers ?? [];
    this.timelineSource = options.timeline;
    this.elicitSource = options.elicit;
    this.store = options.store ?? new InMemoryPromptStore();
    this.view = View.collection(this.store, (r) => r.name);
    // Genesis (ADR 93): the definition's hydrator, resolved — not RUN — here.
    // Definitions are inert until install; genesis runs at session-open via
    // `hydrate()`. No default: a `store` alone loads nothing.
    this.hydrator = options.hydrate as PromptsHydrator | undefined;

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming, and enumeration
    // all derive from these; the pre-registry `handleMessage` switch is
    // gone. Payloads carried no validation before the registry; schemas
    // stay off for parity. The optional `render` fn on register/update
    // declarations is in-process-only convenience (ADR 51 §1.2 excludes
    // ops with REQUIRED function parameters; the addressable form
    // carries `template` data — same precedent as `knobs:register`'s
    // optional `validate`).
    // NO scope factory. The owning session is gap-filled by `makeEvent` from the
    // harness's construction-bound `parentScope` (BaseHarness), so a command that
    // adds no dims of its own declares nothing. Every command here previously
    // carried `() => ({ sessionId: this.scopeId })` — the COMPOSED key
    // `<sessionId>:<surface>`, which no session-scoped subscription can match.
    this.register = this.command({
      name: "prompts:register",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: PromptsRegisterInput) => this.applyRegister(i),
    });
    this.update = this.command({
      name: "prompts:update",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: PromptsUpdateInput) => this.applyUpdate(i),
    });
    this.remove = this.command({
      name: "prompts:remove",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: PromptsRemoveInput) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
    });
    this.invoke = this.command({
      name: "prompts:invoke",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: PromptsInvokeInput) => this.applyInvoke(i),
    });
    // `prompts:render` — the RENDER (was `prompts:get`). Renamed so the wire
    // verb matches the handle method `render(input)`; `prompts:get` is now the
    // declaration read below.
    this.render = this.command({
      name: "prompts:render",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: PromptsGetInput) => this.applyGet(i),
    });
    // NO `prompts:complete` command. The completion door is the plain
    // `complete()` method below, beside these verbs but deliberately not among
    // them — a keystroke must not mint a journaled operation. See its doc-block.

    // ─── Wire read commands (three-audiences-plan G-prep) — the enumeration +
    // read lane a client prompts handle needs. Registered for their side effect
    // (wire-reachability + `commands/list` enumeration); the SYNC `get`/`list`
    // methods serve in-process reads, so the returned callables are discarded.
    // Both project to the SERIALIZABLE `PromptDeclarationRecord` slice (the view
    // records) — `template`/`render` never cross the wire.
    //
    // `prompts:get` — declaration read by name (wire-safe record; null on miss).
    this.command({
      name: "prompts:get",
      exposure: "wire",
      handler: (i: { name: string }) => Effect.sync(() => this.view.getSync(i.name) ?? null),
    });
    // `prompts:list` — declarations as wire-safe records (name-sorted), paged.
    // Paginated on the WIRE only: the sync `list()` stays the bounded in-process
    // snapshot. Pages slice the same sorted array, so a cursor walk and a
    // snapshot agree.
    // TODO(page-size-seam): page size is the shared DEFAULT_PAGE_SIZE. Only
    // `@agentick/resources` has a per-harness `pageSize` option today; give
    // skills/prompts/tools one when a second adopter asks, not before.
    this.command({
      name: "prompts:list",
      exposure: "wire",
      handler: (i: PromptsListInput) =>
        Effect.sync(() => {
          const sorted = this.view
            .listSync()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
          const { page, nextCursor } = paginate(sorted, i?.cursor);
          return { prompts: page, ...omitUndefined({ nextCursor }) };
        }),
    });
  }

  /**
   * The Effect-canonical render surface (ADR 77, the dual-typed edge) — the
   * composable Effect twin of `render`. An in-fiber caller (the MCP server's
   * prompts projection, running inside its `mcp:command:get-prompt` crossing)
   * reaches this so the render composes in the SAME fiber tree: the
   * `prompts:command:render` op parents under the crossing and the
   * declaration's `render(args, ctx)` sees the crossing's identity. Through the
   * Promise facade it would re-enter Effect on a root fiber and lose both. Both
   * faces dispatch the SAME declared command — `fx.render` is the sugar over
   * `commandEffect`, typed via {@link PromptsFx}.
   *
   * `fx.complete` is the exception that proves the rule: `complete` is
   * deliberately NOT a command (no journaled op per keystroke), so there is no
   * `commandEffect` to sugar and the twin is hand-written. It is on `.fx` anyway
   * because what an in-fiber caller needs from it is the FIBER — the MCP server's
   * completion projection composes it so an inline resolver sees the connecting
   * client's identity instead of this harness's owning session.
   */
  get fx(): PromptsFx {
    return this.fxProxy({
      complete: ((input: PromptsCompleteInput) => this.completeEffect(input)) as never,
    }) as unknown as PromptsFx;
  }

  /**
   * Replace the loader set used by `reload()` and the lookup-on-miss
   * fallback in `invoke()` / `get()`. Called by `withPrompts` at
   * install time; adopters can also swap the loader set at runtime.
   */
  setHydrator(hydrate: PromptsHydrator | undefined): void {
    this.hydrator = hydrate;
  }

  // ─────────── Dynamic surface ───────────

  /**
   * Re-run the source hydrator, diff against current state, and apply adds +
   * updates (and removes when `pruneMissing: true`). Returns a summary of names
   * touched.
   *
   * Unlike GENESIS, a reload goes through the OPS (`prompts:register` /
   * `prompts:update` / `prompts:remove`), so the diff is journaled,
   * guard-vetoable, and durable. The seed exemption is a session-open concession,
   * not a licence for every later read of the source.
   *
   * A harness with NO hydrator reloads to nothing touched — including under
   * `pruneMissing`, because the absence of a source is not a claim that the
   * catalog should be empty.
   *
   * **Caveat:** the diff only looks at registered prompts; loaded prompts that
   * lack `template` and `render` are still passed through to `register` (the
   * harness rejects at `register` time if the declaration is malformed).
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    // NO SOURCE is not the same statement as AN EMPTY SOURCE. A detached (or
    // never-attached) hydrator has nothing to say about what the catalog should
    // hold, so a reload is a total no-op — in particular `pruneMissing` must not
    // read the absence of a source as "the source has nothing" and wipe the
    // catalog.
    if (this.hydrator === undefined) return { added: [], updated: [], removed: [] };
    const fresh = new Map<string, PromptDeclaration>();
    for (const input of await this.runHydrator()) {
      fresh.set(input.declaration.name, input.declaration);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const [name, decl] of fresh) {
      if (this.view.hasSync(name)) {
        await this.update({
          name,
          declaration: {
            description: decl.description,
            ...(decl.title !== undefined ? { title: decl.title } : {}),
            ...(decl.arguments ? { arguments: decl.arguments } : {}),
            ...(decl.template !== undefined ? { template: decl.template } : {}),
            ...(decl.render !== undefined ? { render: decl.render } : {}),
            ...(decl.version !== undefined ? { version: decl.version } : {}),
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
   * Lookup-on-miss, used by `invoke()` / `render()` and available publicly.
   * Returns the registered prompt if present; otherwise re-runs the source
   * hydrator and registers the first record with that name. `null` when the
   * source does not have it.
   *
   * The hydrator produces the WHOLE source set, so a miss costs a full source
   * read. That is the honest price of one source seam, and it matches what the
   * loader vocabulary actually did (every non-array source's `lookup` was already
   * `load()` + find). For a catalog large enough to care, put it behind a `store`
   * — the store's `query` IS the targeted read port.
   */
  async resolve(name: string): Promise<PromptDeclaration | null> {
    const existing = this.declarationOf(name);
    if (existing) return existing;
    if (this.hydrator === undefined) return null;
    const found = (await this.runHydrator()).find((p) => p.declaration.name === name);
    if (found === undefined) return null;
    await this.register(found);
    return this.declarationOf(name) ?? null;
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
    throw new PromptNotFound({ promptName: name });
  }

  // ─────────── The completion door ───────────

  /**
   * Complete one ARGUMENT of one prompt — what a composer offers while the user
   * types into a slot.
   *
   * ## Not a command, on purpose
   *
   * Every other verb on this harness is a `this.command(...)`: a journaled
   * operation with `requested → terminal` envelopes, an inbox address, a wire
   * name. This one is a plain async method, for the reason the completions harness
   * gives for its own `resolve` — completion fires PER KEYSTROKE, and one
   * operation per character typed floods the recovery/audit spine with ephemeral
   * queries for zero durability benefit (completions.md §5). The ctx is still
   * MINTED rather than hand-assembled, so a resolver sees the owning session's
   * identity and the `log`/`trace`/`metrics`/`run` facets exactly as `render` does.
   *
   * ## The three answers, and why they fall out of the re-join
   *
   * It reads the RE-JOINED declaration ({@link declarationOf}), so the three
   * shapes `restorePromptArguments` can hand back are already the three arms of
   * {@link PromptsCompleteOutcome}: a FUNCTION is an inline resolver and runs here
   * (`resolved`); a STRING is a registry address this package will not chase —
   * prompts holds resolvers, it does not own the registry that runs them — so the
   * name goes back to the caller (`ref`); NOTHING means either the argument
   * declares no completion or its sidecar did not survive a restore
   * (`unavailable`).
   *
   * An unknown ARGUMENT name is `unavailable`, not an error: completion never
   * protocol-errors on an unknown argument (MCP parity). An unknown PROMPT does
   * throw — the caller named something that does not exist.
   *
   * Lookup-on-miss runs first, the same source seam `invoke` / `render` use, so
   * completing an argument of a lazily-catalogued prompt works. A miss costs one
   * full hydrator read; it happens once, because the lookup registers what it finds.
   *
   * @throws {PromptNotFound} no prompt by that name, and no source has it.
   * @throws {CompletionResolveFailed} an inline resolver threw or rejected.
   * @verifiedBy packages/prompts/src/__tests__/complete.spec.ts
   */
  async complete(input: PromptsCompleteInput): Promise<PromptsCompleteOutcome> {
    // ONE ctx mint, shared by the resolver invocation and the counter on every
    // arm. OFF-FIBER: the trunk is this harness's construction-bound scope,
    // because a plain async door has no enclosing Effect to read.
    return this.completeWith(input, (i) => this.completionCtx(i));
  }

  /**
   * The Effect-canonical completion twin — the body of {@link fx}.complete.
   *
   * Identical to {@link complete} in every respect but the ctx mint, which is the
   * whole point: `currentOperationCtx` reads the CALLER's fiber, so a resolver
   * invoked through an MCP `completion/complete` crossing sees that connection's
   * authenticated identity (and its `ctx.mcp` boundary facet, credential
   * included) rather than the session that happens to own this harness.
   *
   * @verifiedBy packages/mcp/src/server/__tests__/projection-completions-seam.spec.ts
   */
  private completeEffect(
    input: PromptsCompleteInput,
  ): Effect.Effect<PromptsCompleteOutcome, PromptsErrorChannel | CompletionsErrorChannel, never> {
    return Effect.gen(this, function* () {
      // IN-FIBER mint (ADR 91): the two boundary facets compose INTO the branded
      // mint via `extras`, and the fiber's published boundary facets (the MCP
      // crossing's `ctx.mcp`) fold in alongside them.
      const ctx: CompletionCtx = yield* this.currentOperationCtx(this.completionFacets(input));
      return yield* Effect.tryPromise({
        try: () => this.completeWith(input, () => ctx),
        catch: (cause) => cause as PromptsErrorChannel | CompletionsErrorChannel,
      });
    });
  }

  /**
   * The three-arm body both faces run. `mintCtx` is the ONLY difference between
   * them, taken as a thunk so the mint happens after the lookup-on-miss (a miss
   * that ends in `PromptNotFound` should not pay for a ctx).
   */
  private async completeWith(
    input: PromptsCompleteInput,
    mintCtx: (input: PromptsCompleteInput) => CompletionCtx,
  ): Promise<PromptsCompleteOutcome> {
    if (!this.view.hasSync(input.name) && this.hydrator !== undefined) {
      await this.resolve(input.name);
    }
    const decl = this.declarationOf(input.name);
    if (decl === undefined) throw new PromptNotFound({ promptName: input.name });

    // Metrics is the honest observability answer for a door that writes no
    // journal envelope: the tally survives, the per-keystroke event does not.
    const ctx = mintCtx(input);
    const tally = (outcome: PromptsCompleteOutcome["kind"]): void => {
      ctx.metrics.count("prompts.complete", 1, { prompt: input.name, outcome });
    };

    const arg = decl.arguments?.find((a) => a.name === input.argument.name);
    const complete = arg?.complete;

    if (typeof complete === "string") {
      tally("ref");
      return { kind: "ref", completeRef: complete };
    }
    if (typeof complete !== "function") {
      tally("unavailable");
      return { kind: "unavailable" };
    }
    try {
      const raw = await complete(input.argument.value, ctx);
      tally("resolved");
      return { kind: "resolved", result: foldCompletionValues(raw) };
    } catch (cause) {
      throw new CompletionResolveFailed({
        completionName: this.completeRefOf(input.name, input.argument.name),
        cause,
      });
    }
  }

  /**
   * The failing resolver's ADDRESS, read off the RECORD where the split put it:
   * its own registry name for a `defineCompletion` source, else the derived
   * `prompt:<prompt>:<arg>`. Never a fabricated label — the ref in the error is
   * the ref a caller can go look up.
   *
   * It comes from the record rather than the re-joined declaration because
   * `completeRef` is a `PromptArgumentRecord` field: the author-facing
   * `PromptArgument` types `complete`, not its projections.
   */
  private completeRefOf(promptName: string, argName: string): string {
    const record = this.view.getSync(promptName);
    return (
      record?.arguments?.find((a) => a.name === argName)?.completeRef ??
      promptCompletionRef(promptName, argName)
    );
  }

  /**
   * Mint the resolver's {@link CompletionCtx} (ADR 91) — through
   * `deriveOperationCtx`, the one branded boundary constructor, never a
   * hand-assembled bag, so the ctx carries the trunk (the owning session's
   * `sessionId` / `principal`), the lazy `log`/`trace`/`metrics`/`run` facets, and
   * the `Derived` brand.
   *
   * The two boundary facets compose INTO the same branded mint rather than being
   * spread over it afterwards, which would erase the brand. `resolvedArguments`
   * is MCP's `context.arguments` flattened onto the name the seam itself uses —
   * the sibling values that make conditional completion possible.
   *
   * The trunk is this harness's construction-bound `parentScope`
   * (`{ sessionId }` for a session-installed harness), NOT an ambient fiber:
   * `complete` is a plain async door with no enclosing Effect. That is the one
   * asymmetry with `render`, which derives in-fiber from the invoking op.
   */
  private completionCtx(input: PromptsCompleteInput): CompletionCtx {
    return this.deriveOperationCtx(this.parentScope ?? {}, this.completionFacets(input));
  }

  /**
   * The two boundary facets, in the shape BOTH mints compose — the off-fiber
   * `deriveOperationCtx` above and the in-fiber `currentOperationCtx` in
   * {@link completeEffect}. `resolvedArguments` is MCP's `context.arguments`
   * flattened onto the name the seam itself uses.
   */
  private completionFacets(input: PromptsCompleteInput): {
    readonly resolvedArguments: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  } {
    return {
      resolvedArguments: input.context?.arguments ?? {},
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
  }

  // ─────────── Sync surface ───────────

  /**
   * COMBINE the two halves back into a full {@link PromptDeclaration}: the
   * serializable record from the {@link projection} + the non-serializable
   * `{ template, render }` from the {@link augmentations} sidecar. The single
   * site the split is re-joined — every read that hands out a full declaration
   * (`get`, `list`, `resolve`, render) goes through here.
   * `undefined` when the record is absent (an orphan sidecar entry — which
   * cannot occur, they are written and dropped together — would be ignored).
   */
  private declarationOf(name: string): PromptDeclaration | undefined {
    const record = this.view.getSync(name);
    if (!record) return undefined;
    const aug = this.augmentations.get(name);
    if (aug === undefined && record.arguments === undefined) return record;
    // Arguments re-join too: an inline resolver comes back off the sidecar, an
    // author's named ref comes back as the string it always was. `completions` is
    // sidecar bookkeeping and NOT a declaration field, so it is destructured off
    // rather than spread — only `{ template, render }` belong on the result.
    const { completions: _completions, ...content } = aug ?? {};
    const args = restorePromptArguments(record.arguments, aug?.completions);
    return {
      ...record,
      ...(args !== undefined ? { arguments: args } : {}),
      ...content,
    };
  }

  get(name: string): PromptDeclaration | undefined {
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
    // The augmentation sidecar is CLEARED — `template`/`render`/`completions` are
    // non-serializable, so a restored prompt has no content until the adopter
    // re-registers it (invoke/render then throw `PromptMissingContent` until they do).
    // Its arguments keep their `completeRef` / `completeRequires` (records, and the
    // metadata a palette reads), but an INLINE resolver is gone — `declarationOf`
    // restores no `complete` for a derived ref with no sidecar rather than handing
    // back an address nothing answers to.
    // The `View` is agnostic to the sidecar; the clear is harness-owned.
    //
    // TODO(store-phase-4): `importSnapshot` is still the snapshot-based resume
    // path for a session restored from an IMAGE. Genesis (`hydrate()`) is the
    // store-authority path; the Phase-4 manifest sweep retires this one.
    this.listCache = null;
    this.view.replace(Object.values(snapshot), this.storeCtx());
    this.augmentations.clear();
  }

  // ─────────── Genesis (ADR 93) ───────────

  /**
   * GENESIS (ADR 93) — run the definition's `hydrate(ctx)` and SEED the catalog
   * with what it returns.
   *
   * Called once at session-open: after identity stamping, before first render,
   * before any register. A no-op when the definition names no `hydrate` — prompts
   * names no default hydrator, so a `store` alone opens empty.
   *
   * **The seed law.** The returned records are ADOPTED into the read view: no
   * `prompts:register` op, no store write. The `{ template, render }` sidecar IS
   * populated from the seed, because that is where a hydrator's function-carrying
   * content has to land (the store slice cannot hold it) — a hydrator is
   * in-process code, so its functions are as real as a register's.
   *
   * **Fork/spawn.** Genesis must not run for a child that inherits its parent's
   * image; that decision belongs to the session, which simply does not call this.
   *
   * @throws {PromptsError._tag === "PromptsHydrateFailed"} the hydrator threw;
   *   session creation fails rather than half-genesising the catalog.
   */
  async hydrate(): Promise<void> {
    if (this.hydrator === undefined) return;
    const records = await this.runHydrator();
    // Invalidate `listCache` BEFORE the seed+ping so a subscriber that reads
    // during a ping sees the complete post-genesis list.
    this.listCache = null;
    for (const { declaration } of records) {
      // Same record/sidecar SPLIT `applyRegister` performs — the serializable
      // slice into the view, the `{ template, render, completions }` code into the
      // sidecar. Populate the sidecar BEFORE the seed's ping so a subscriber
      // reading during the ping sees the combined declaration.
      const args = normalizePromptArguments(declaration.name, declaration.arguments);
      this.setAugmentation(declaration.name, {
        template: declaration.template,
        render: declaration.render,
        ...omitUndefined({ completions: args.completions }),
      });
      this.view.seedSync(
        {
          name: declaration.name,
          description: declaration.description,
          ...omitUndefined({
            title: declaration.title,
            arguments: args.records,
            version: declaration.version,
            metadata: declaration.metadata,
          }),
        },
        { ping: true },
      );
    }
  }

  /**
   * Run the source hydrator with the derived genesis ctx, wrapping any throw in
   * the typed {@link PromptsHydrateFailed}. Shared by genesis, `reload()`, and
   * `resolve()` — one source, one failure shape.
   */
  private async runHydrator(): Promise<readonly PromptSeed[]> {
    const hydrate = this.hydrator;
    if (hydrate === undefined) return [];
    try {
      return await hydrate(this.hydrateCtx());
    } catch (cause) {
      throw cause instanceof PromptsHydrateFailed ? cause : new PromptsHydrateFailed({ cause });
    }
  }

  /**
   * Derive the ctx handed to the genesis hydrator (ADR 91/93).
   *
   * Minted through `deriveOperationCtx` — the branded boundary constructor — so
   * the hydrator sees the session's identity (`sessionId`, `principal`) and
   * diagnostics (`log`/`trace`/`metrics`/`run`), plus two boundary facets composed
   * INTO the same branded mint: the definition's `store` (the typed `ctx.store`
   * facet) and the journal's READ slice (`journalReader`).
   *
   * The result is also a valid `StoreCtx`, so `hydrateFromStore` hands `ctx`
   * straight to `store.query(undefined, ctx)` with no repacking.
   */
  private hydrateCtx(): PromptsHydrateCtx {
    return this.deriveOperationCtx(
      // NOT an event scope — the STORE KEY. A hydrator reads
      // `store.read(ctx.sessionId ?? "", ctx)`, and the key is the composed
      // `scopeId` this harness's store was keyed with. `StoreCtx` naming its key
      // `sessionId` is the collision; see TODO(store-ctx-key-name) in
      // `@agentick/timeline`.
      // NOT AN EVENT SCOPE — the STORE KEY. Load-bearing: this exact phrase is
      // the opt-out the `event-scope-authority` sweep greps for. It reads as a
      // restatement of the sentence above and is not one; deleting it fails that
      // conformance test.
      { sessionId: this.scopeId },
      {
        store: this.store,
        journalReader: this.journal,
        ...(this.principal !== undefined ? { principal: this.principal } : {}),
      },
    ) as PromptsHydrateCtx;
  }

  // ─────────── Inbox routing ───────────

  /**
   * `prompts:register/update/remove/invoke/render/get/list` are declared
   * commands — routed by the BaseHarness command registry before this fallthrough.
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
        return Effect.fail(new PromptAlreadyExists({ promptName: decl.name }));
      }
      // Split: the serializable record writes through the view (sync cache first,
      // durable store off the critical path, a render ping); the non-serializable
      // `{ template, render }` re-attaches to the sidecar, never the store.
      // Invalidate `listCache` and populate the sidecar BEFORE the view write so a
      // subscriber that reads during the write's synchronous ping sees BOTH the
      // fresh list and the combined declaration (the sidecar-merged view).
      // The arguments split (completions.md §2.1): each `complete` resolver moves
      // to the sidecar under its DERIVED ref, each named ref stays on the record
      // as `completeRef`. A `PromptArgument` carrying a resolver does not fit
      // `PromptArgumentRecord`, so skipping this is a compile error, not a leak.
      const args = normalizePromptArguments(decl.name, decl.arguments);
      const record: PromptDeclarationRecord = {
        name: decl.name,
        description: decl.description,
        ...omitUndefined({
          title: decl.title,
          arguments: args.records,
          version: decl.version,
          metadata: decl.metadata,
        }),
      };
      this.listCache = null;
      this.setAugmentation(decl.name, {
        template: decl.template,
        render: decl.render,
        ...omitUndefined({ completions: args.completions }),
      });
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
        return Effect.fail(new PromptNotFound({ promptName: input.name }));
      }
      const existingAug = this.augmentations.get(input.name);
      const patch = input.declaration;
      // A patch that names `arguments` REPLACES them wholesale, so it also
      // replaces their resolvers: re-split the incoming list. A patch that is
      // silent about arguments keeps both halves of the existing split — the
      // record's descriptors AND the sidecar's resolvers, which stay in step
      // because they are only ever written together.
      const args: NormalizedPromptArguments =
        patch.arguments !== undefined
          ? normalizePromptArguments(input.name, patch.arguments)
          : {
              ...omitUndefined({ records: existingRecord.arguments }),
              ...omitUndefined({ completions: existingAug?.completions }),
            };
      const updatedRecord: PromptDeclarationRecord = {
        name: input.name,
        description: patch.description ?? existingRecord.description,
        ...omitUndefined({
          title: patch.title ?? existingRecord.title,
          arguments: args.records,
          version: patch.version ?? existingRecord.version,
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
        ...omitUndefined({ completions: args.completions }),
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
    if (source.completions !== undefined) aug.completions = source.completions;
    if (aug.template !== undefined || aug.render !== undefined || aug.completions !== undefined) {
      this.augmentations.set(name, aug);
    } else {
      this.augmentations.delete(name);
    }
  }

  /**
   * Resolve the append target for THIS invoke. A directly-injected capability
   * passes through; a provider is called every time until it hits, then the hit
   * is cached (the timeline of a live session never changes identity).
   *
   * Deliberately NOT resolved at construction: see {@link TimelineAppendSource}.
   */
  private resolveTimeline(): TimelineAppendCapability | undefined {
    if (this.resolvedTimeline !== undefined) return this.resolvedTimeline;
    const source = this.timelineSource;
    if (source === undefined) return undefined;
    const resolved = typeof source === "function" ? source() : source;
    if (resolved !== undefined) this.resolvedTimeline = resolved;
    return resolved;
  }

  /**
   * The session's {@link Elicit}, resolved through the provider on every render
   * until one answers — the {@link resolveTimeline} discipline, and for the same
   * ordering reason. A miss is never cached: an elicit source published after
   * this harness was built starts working on the next render.
   */
  private resolveElicit(): Elicit | undefined {
    if (this.resolvedElicit !== undefined) return this.resolvedElicit;
    const source = this.elicitSource;
    if (source === undefined) return undefined;
    const resolved = typeof source === "function" ? source() : source;
    if (resolved !== undefined) this.resolvedElicit = resolved;
    return resolved;
  }

  /**
   * The render's boundary facets, composed INTO the branded mint via `extras`
   * (never spread over it afterwards, which would erase the brand).
   *
   * `published` is what the enclosing crossing put on the fiber, and an `elicit`
   * already there WINS: extras beat boundary facets on a key collision, so
   * without this check a session-scoped elicit would silently override a
   * crossing's own — asking the wrong human. A crossing that can reach the
   * caller directly (an MCP connection, whose client serves
   * `elicitation/create`) is nearer to them than the session that happens to own
   * this harness. Nothing publishes `elicit` today; this is what makes wiring
   * that half a one-line change rather than a defect.
   */
  private renderFacets(published: Readonly<Record<string, unknown>>): {
    readonly elicit?: Elicit;
  } {
    if (published.elicit !== undefined) return {};
    const elicit = this.resolveElicit();
    return elicit === undefined ? {} : { elicit };
  }

  private applyInvoke(
    input: PromptsInvokeInput,
  ): Effect.Effect<PromptsGetResult, PromptsError, never> {
    // ADR 91 §2 — derive the invoking op's branded ctx in-fiber and thread it
    // into `render(args, ctx)`, so a dynamic prompt can render per-principal
    // and ask through `ctx.elicit` for what the invoke did not supply.
    return Effect.gen(this, function* () {
      const ctx = yield* this.currentOperationCtx(this.renderFacets(yield* getBoundaryFacets));
      return yield* Effect.tryPromise({
        try: async () => {
          // Lookup-on-miss: if the name isn't yet registered, re-run the source
          // hydrator. On hit, the prompt is registered (a nested
          // `prompts:register` command) + invoke proceeds; on miss,
          // `renderToMessages` throws `PromptNotFound`.
          if (!this.view.hasSync(input.name) && this.hydrator !== undefined) {
            await this.resolve(input.name);
          }
          const result = await this.renderToMessages(input.name, input.args, ctx);
          // Append the rendered messages directly to the session timeline
          // (ADR 53 — input appends the moment it exists; no queue/drain
          // tier). The next render sees them via <Timeline/>. When no
          // timeline is wired (e.g., test setup without session), skip —
          // adopters use `get()` for that path. Resolved HERE, not at
          // construction: the session's timeline is born after this harness is
          // (#257).
          const timeline = this.resolveTimeline();
          if (timeline === undefined) {
            // The skip used to be silent, and it stayed silent through an entire
            // release: every default `createApp` deployment rendered its prompts
            // into the void because the eager resolve missed. Warn ONCE per
            // harness (an invoke-driven session would otherwise emit per message).
            if (!this.warnedNoTimeline) {
              this.warnedNoTimeline = true;
              ctx.log.warn(
                {
                  msg: "prompts:invoke rendered but appended nothing — no timeline is wired to this harness",
                  prompt: input.name,
                  scopeId: this.scopeId,
                },
                "@agentick/prompts",
              );
            }
          }
          if (timeline) {
            const ts = Date.now();
            // MATERIALIZATION PROVENANCE — every entry queued here carries WHO
            // put it there, so a chat projection can render an invoked prompt as
            // a pill instead of a wall of text the user never typed, and an audit
            // can follow `opId` back to this operation. Every field is a fact
            // already in hand at this site: the name is the op input, the args are
            // that input verbatim, the `opId` is this command's, and the version
            // is the record's own declared string. Nothing is derived, hashed, or
            // computed. `render()` / `get()` stamp NOTHING — they queue nothing.
            const source: PromptMessageSource = {
              name: input.name,
              ...omitUndefined({
                args: input.args,
                opId: ctx.opId,
                version: this.view.getSync(input.name)?.version,
              }),
            };
            for (const msg of result.messages) {
              await timeline.append({
                kind: "message",
                message: {
                  id: `m_${generateId()}`,
                  role: msg.role,
                  content: msg.content,
                  ts,
                  metadata: stampPromptSource(msg.metadata, source),
                },
              });
            }
          }
          return result;
        },
        catch: (cause): PromptsError =>
          isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
      });
    });
  }

  private applyGet(input: PromptsGetInput): Effect.Effect<PromptsGetResult, PromptsError, never> {
    // ADR 91 §2 — same in-fiber ctx derivation + threading as `applyInvoke`,
    // `elicit` facet included: `render()` renders the same declaration through
    // the same seam, and a prompt that asks must not depend on which door was
    // used. (The MCP `prompts/get` projection reaches the render through THIS
    // path — see `renderFacets` on whose elicit it gets.)
    return Effect.gen(this, function* () {
      const ctx = yield* this.currentOperationCtx(this.renderFacets(yield* getBoundaryFacets));
      return yield* Effect.tryPromise({
        try: async () => {
          // Same lookup-on-miss path as `applyInvoke` — one source seam.
          if (!this.view.hasSync(input.name) && this.hydrator !== undefined) {
            await this.resolve(input.name);
          }
          return this.renderToMessages(input.name, input.args, ctx);
        },
        catch: (cause): PromptsError =>
          isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
      });
    });
  }

  private async renderToMessages(
    name: string,
    rawArgs: Readonly<Record<string, unknown>> | undefined,
    ctx: PromptRenderCtx,
  ): Promise<PromptsGetResult> {
    const decl = this.declarationOf(name);
    if (!decl) throw new PromptNotFound({ promptName: name });

    // 1. Validate args against the declared schemas.
    const args = await validateArgs(name, decl.arguments, rawArgs ?? {});

    // 2. Resolve the content — `render(args, ctx)` wins; fall back to `template`.
    let content: unknown;
    if (decl.render) {
      try {
        content = await Promise.resolve(decl.render(args, ctx));
      } catch (cause) {
        throw new PromptRenderFailed({ promptName: name, cause });
      }
    } else if (decl.template !== undefined) {
      content = decl.template;
    } else {
      throw new PromptMissingContent({ promptName: name });
    }

    // 3. Dispatch to native handler or matching renderer.
    const messages = await this.dispatchContent(name, content, args);

    // 4. Surface the DECLARATION's metadata bag on the result. Nothing is
    // invented per-render: this is the author's bag, copied verbatim, so a
    // consumer holding only a result can read what the declaration said about
    // itself (MCP's `GetPromptResult._meta` rides `metadata.mcp.meta`, the same
    // key `prompts/list` projects from). Absent stays absent.
    return omitUndefined({
      description: decl.description,
      messages,
      metadata: decl.metadata,
    }) as PromptsGetResult;
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
          throw new PromptRenderFailed({ promptName: name, cause });
        }
      }
    }
    throw new PromptRenderFailed({
      promptName: name,
      cause: `no registered renderer handles content (typeof=${typeof content}); registered: [${this.renderers.map((r) => r.name).join(", ")}]`,
    });
  }
}

// ─────────── Materialization provenance ───────────

/**
 * MERGE the prompt stamp into one rendered message's metadata, at
 * `metadata.source.prompt` (the ADR 58 convention — see the `MessageSource` seed
 * in spec, and why the grammar is a keyed bag rather than a `kind` union).
 *
 * Two laws, both about not destroying what someone else said:
 *
 *  - **Merge, never clobber.** A render fn may put its own keys on a message's
 *    metadata (`cache`, `providerMetadata`, adopter keys); the stamp is one more
 *    key beside them.
 *  - **An existing `source` WINS.** If the rendered message already carries one,
 *    the render fn stamped it deliberately — and it is the closer authority: it
 *    knows what that particular message is (a quoted inbound Telegram message, a
 *    replayed transcript line) where the invoke only knows it rendered something.
 *    The more specific claim survives.
 *
 * @verifiedBy packages/prompts/src/__tests__/provenance.spec.ts
 */
function stampPromptSource(
  metadata: MessageEntry["metadata"],
  source: PromptMessageSource,
): MessageEntry["metadata"] {
  if (metadata?.source !== undefined) return metadata;
  return { ...metadata, source: { prompt: source } };
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
          promptName,
          argument: arg.name,
        }) satisfies PromptsError;
      }
      continue;
    }
    if (arg.schema) {
      const result = await runStandardSchema(arg.schema, value);
      if (result.issues) {
        throw new PromptArgumentInvalid({
          promptName,
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
