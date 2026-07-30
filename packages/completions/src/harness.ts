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
 *   - the resolver's ctx is still MINTED, never hand-assembled — through
 *     `deriveOperationCtx`, the one branded boundary-ctx constructor (ADR 91),
 *     so a resolver sees the owning session's identity and the
 *     `log`/`trace`/`metrics`/`run` facets exactly like a `ResourceResolver` does.
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
export type CompletionsHarnessOptions = BaseHarnessOptions;

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
    const resolver = this.resolvers.get(name);
    if (resolver === undefined) throw new CompletionNotFound({ completionName: name });
    try {
      return normalizeCompletionResult(await resolver(input.value, this.completionCtx(input)));
    } catch (cause) {
      // A CompletionNotFound raised by a resolver's own nested resolve passes
      // through; anything else the resolver throws is a resolve failure.
      if (cause instanceof CompletionNotFound) throw cause;
      throw new CompletionResolveFailed({ completionName: name, cause });
    }
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
   * because `resolve` is a plain async door with no enclosing Effect.
   *
   * TODO(completions-p3): when the MCP server harness resolves
   * `completion/complete` through this seam, it wants the CROSSING's trunk (so
   * the resolver sees the connection's authenticated identity and the completion
   * parents under the crossing). That needs an in-fiber twin — a `.fx`-style
   * `resolveEffect` using `currentOperationCtx()` — alongside this off-fiber
   * door. Today MCP threads its own ctx at its own projection.
   */
  private completionCtx(input: CompletionsResolveInput): CompletionCtx {
    return this.deriveOperationCtx(this.parentScope ?? {}, {
      resolvedArguments: input.resolvedArguments ?? {},
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
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
