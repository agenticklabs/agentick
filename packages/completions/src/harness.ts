/**
 * `CompletionsHarness` — a `name → resolver` registry and one resolve door.
 *
 * Extends {@link BaseHarness} so it rides the substrate like every other
 * harness (scope identity, inbox address, close lifecycle, the derived ctx
 * spine). It owns NO data: a resolver reads candidates from wherever they
 * already live — a tenant DB, a store, a static list.
 *
 * ## `resolve` is NOT a declared command — and that is the whole point
 *
 * Every other harness's read surface is a `this.command(...)`, which mints a
 * journaled operation with `requested → terminal` envelopes. Completion fires
 * PER KEYSTROKE. Journaling one operation per character typed would flood the
 * recovery/audit spine with ephemeral queries for zero durability benefit —
 * which is precisely the refutation that kept completion out of tool dispatch
 * (completions.md §5, refutation 1). So `resolve` is a plain async method:
 *
 *   - no `runOperation`, no journal write, no bus envelope;
 *   - the resolver's ctx is still MINTED, never hand-assembled — through the
 *     branded boundary-ctx constructors (ADR 91), so a resolver sees an
 *     identity and the `log`/`trace`/`metrics`/`run` facets exactly like a
 *     `ResourceResolver` does.
 *
 * The door has two faces for the ONE reason a ctx can come from two places:
 * `resolve` (Promise) mints from this harness's construction-bound scope, and
 * `fx.resolve` (Effect) mints from the CALLER's fiber. An inbound MCP
 * `completion/complete` needs the second — its resolver must see the connecting
 * client's identity, not the session that happens to own the registry. Neither
 * face journals; the twin buys the fiber, not an envelope.
 *
 * Registration is likewise a plain synchronous insert: `register` carries a
 * REQUIRED resolver function, which makes it unaddressable over a wire by
 * construction (ADR 51 §1.2). The one notifier stream is registry topology —
 * `subscribeAll` fires on register / unregister, which is what tells a composer
 * its completable slot set changed.
 *
 * @see docs/proposals/v2/completions.md
 * @see packages/spec/src/protocol/completions-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type BaseHarnessOptions, type Unsubscribe } from "@agentick/runtime";
import type {
  CompletionCtx,
  CompletionResolver,
  CompletionResult,
  CompletionsErrorChannel,
  CompletionsFx,
  CompletionsHarnessProtocol,
  CompletionsResolveInput,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";
import { CompletionNotFound, CompletionResolveFailed, HandlerError } from "@agentick/spec";
import { createNotifier, type Notifier } from "@agentick/pubsub";

import { normalizeCompletionResult } from "./builders.js";

const SURFACE = "completions" as const;
type CompletionsSurface = typeof SURFACE;

/**
 * `extends BaseHarnessOptions` so every slot the base accepts — `parentScope`,
 * `principal`, telemetry, the interceptor fold — arrives without being
 * re-declared and re-forwarded by hand. The harness adds no options of its own:
 * a registry has nothing to configure.
 */
export type CompletionsHarnessOptions = BaseHarnessOptions<unknown, CompletionsSurface>;

export class CompletionsHarness
  extends BaseHarness<CompletionsSurface>
  implements CompletionsHarnessProtocol
{
  /** `name → resolver`. NON-serializable, hence no snapshot surface. */
  private readonly resolvers = new Map<string, CompletionResolver>();

  /** Registry-topology fan-out (register / unregister). */
  private readonly changed: Notifier = createNotifier();

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: CompletionsHarnessOptions = {},
  ) {
    // Forward the WHOLE bag: nothing to enumerate, so nothing to forget.
    super(SURFACE, scopeId, journal, bus, inbox, options);
    // NO declared commands — see the class doc-block. `resolve` deliberately
    // does not journal.
  }

  // ─────────── Registration (plain methods — ADR 51 §1.2) ───────────

  register(name: string, resolver: CompletionResolver): Unsubscribe {
    this.resolvers.set(name, resolver);
    this.changed.notify();
    return () => {
      // Only remove while this binding is still the current one: an UPSERT means
      // a stale handle from a replaced registration must not delete its
      // replacement.
      if (this.resolvers.get(name) !== resolver) return;
      this.resolvers.delete(name);
      this.changed.notify();
    };
  }

  // ─────────── Sync surface ───────────

  has(name: string): boolean {
    return this.resolvers.has(name);
  }

  list(): readonly string[] {
    return [...this.resolvers.keys()].sort();
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.changed.subscribe(listener);
  }

  // ─────────── The door ───────────

  async resolve(name: string, input: CompletionsResolveInput): Promise<CompletionResult> {
    const resolver = this.requireResolver(name);
    // ONE ctx mint per resolve, shared by the resolver call and the counter in
    // `runResolver`. OFF-FIBER: the trunk is this harness's construction-bound
    // scope, because a plain async door has no enclosing Effect to read.
    return this.runResolver(name, resolver, input, this.completionCtx(input));
  }

  /**
   * The Effect-canonical resolve surface — the twin an in-fiber caller composes
   * with `yield*`. The MCP server's completions projection reaches this from
   * inside its `mcp:command:complete` crossing so the resolver runs on the
   * CROSSING's fiber: its ctx carries the connection's authenticated identity
   * (`ctx.mcp.user`, the boundary facet the crossing published) instead of the
   * owning session's, and its `ctx.run` / `ctx.trace` nest under the crossing.
   * Through the Promise facade above it would see this harness's own scope and
   * nothing of the caller.
   *
   * Unlike every sibling `.fx`, this is NOT sugar over `commandEffect` — there is
   * no command to sugar. What the twin buys is the FIBER, not an envelope; the
   * no-journal-per-keystroke law holds on both faces. See {@link CompletionsFx}.
   *
   * @verifiedBy packages/completions/src/__tests__/harness.spec.ts
   */
  get fx(): CompletionsFx {
    return this.fxProxy({
      resolve: ((name: string, input: CompletionsResolveInput) =>
        this.resolveEffect(name, input)) as never,
    }) as unknown as CompletionsFx;
  }

  /** In-fiber body of {@link fx}.resolve — mints the ctx from the ambient trunk. */
  private resolveEffect(
    name: string,
    input: CompletionsResolveInput,
  ): Effect.Effect<CompletionResult, CompletionsErrorChannel, never> {
    return Effect.gen(this, function* () {
      // `Effect.fail`, NOT the throwing `requireResolver` the Promise face uses: a
      // synchronous throw inside `Effect.gen` becomes a DEFECT, which escapes the
      // declared `CompletionsErrorChannel` and reaches a caller as an unwrapped
      // crash rather than the typed miss it is. The unknown-ref-is-silence rule
      // downstream depends on this arriving as a failure.
      const resolver = this.resolvers.get(name);
      if (resolver === undefined) {
        return yield* Effect.fail(new CompletionNotFound({ completionName: name }));
      }
      // IN-FIBER mint (ADR 91): the trunk comes from the ambient operation, and
      // the two boundary facets compose INTO the branded mint via `extras` — not
      // a post-mint spread, which would erase the brand and force the lazy
      // facets. Fiber-published boundary facets (the MCP crossing's `ctx.mcp`)
      // fold in too, which is how a resolver reaches the caller's credential.
      const ctx: CompletionCtx = yield* this.currentOperationCtx(this.completionFacets(input));
      return yield* Effect.tryPromise({
        try: () => this.runResolver(name, resolver, input, ctx),
        catch: (cause) => cause as CompletionsErrorChannel,
      });
    });
  }

  /**
   * Lookup-or-throw. `CompletionNotFound` is the ONE protocol error a caller
   * cannot avoid by typing differently, so both faces raise it identically.
   */
  private requireResolver(name: string): CompletionResolver {
    const resolver = this.resolvers.get(name);
    if (resolver === undefined) throw new CompletionNotFound({ completionName: name });
    return resolver;
  }

  /**
   * Invoke the resolver and fold its answer — shared by both faces so the tally,
   * the normalization, and the error mapping cannot drift between them. The ctx
   * is the ONLY thing the two faces disagree about, which is the whole point of
   * the twin.
   *
   * The metrics tally is the honest observability answer for a surface that
   * deliberately writes no journal envelope: the count survives, the
   * per-keystroke event does not. Fire-and-forget — nothing here is control flow,
   * and off the telemetry path `count` is the frozen no-op singleton.
   */
  private async runResolver(
    name: string,
    resolver: CompletionResolver,
    input: CompletionsResolveInput,
    ctx: CompletionCtx,
  ): Promise<CompletionResult> {
    ctx.metrics.count("completions.resolve", 1, { name });
    try {
      return normalizeCompletionResult(await resolver(input.value, ctx));
    } catch (cause) {
      // A CompletionNotFound raised by a resolver's own nested resolve passes
      // through; anything else the resolver throws is a resolve failure.
      if (cause instanceof CompletionNotFound) throw cause;
      throw new CompletionResolveFailed({ completionName: name, cause });
    }
  }

  /**
   * The two boundary facets, in the shape both mints compose. `resolvedArguments`
   * defaults to `{}` — a resolver reads it unconditionally.
   */
  private completionFacets(input: CompletionsResolveInput): {
    readonly resolvedArguments: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  } {
    return {
      resolvedArguments: input.resolvedArguments ?? {},
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
  }

  /**
   * Mint the resolver's {@link CompletionCtx} (ADR 91).
   *
   * `deriveOperationCtx` — never a hand-assembled bag — so the ctx carries the
   * trunk (the owning session's `sessionId` / `principal`), the lazy
   * `log`/`trace`/`metrics`/`run` facets, and the `Derived` brand. The two
   * boundary facets (`resolvedArguments`, `signal`) compose INTO the same
   * branded mint rather than being spread over it afterwards, which would erase
   * the brand and force the lazy getters.
   *
   * The trunk is this harness's construction-bound `parentScope` (`{ sessionId }`
   * for a session-installed harness). It is NOT read from an ambient fiber,
   * because `resolve` is a plain async door with no enclosing Effect. A caller
   * that HAS a fiber and wants ITS trunk — the MCP server's completions
   * projection, resolving inside its crossing — composes {@link fx}.resolve
   * instead; that is the one asymmetry between the two faces.
   */
  private completionCtx(input: CompletionsResolveInput): CompletionCtx {
    return this.deriveOperationCtx(this.parentScope ?? {}, this.completionFacets(input));
  }

  // ─────────── Inbox routing ───────────

  /**
   * No declared commands and no message types of its own — a completion is
   * resolved through the in-process door, never addressed over the inbox.
   * Anything that arrives here is a mis-address.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({ cause: `Unknown completions message type: ${msg.type}` }),
    );
  }
}
