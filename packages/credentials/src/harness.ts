/**
 * `CredentialsHarness` — substrate harness around a {@link CredentialsStore}
 * adapter with reactive change notification.
 *
 * The harness binds the protocol surface (Effect-typed substrate
 * internals; Promise-typed public CRUD) to a pluggable adapter and
 * fans out per-key change events to in-process subscribers.
 *
 * Server-resident always — `bridges.credentials` is populated by an
 * app- or gateway-level `withCredentials({ store })` install
 * (#281b.2). The slot itself never crosses the wire; client-driven
 * lifecycle (re-auth, disconnect) flows through the wire-extensions
 * framework (#280) once that lands.
 *
 * ## Async-only, NO `View` — the deliberate no-view store
 *
 * Credentials is the counter-example that closes the store taxonomy: a
 * store-backed harness holds a synchronous {@link View} / `LogView` read-model
 * **IFF it has a synchronous read surface** — NOT because it is store-backed.
 * The render-read harnesses (knobs / state / skills / prompts / tasks) each
 * hold a `View` in front of their async store because their protocol reads are
 * served DURING RENDER, which is synchronous. This harness holds **no `View`
 * and no sync cache**: every read (`get`/`has`/`keys`) awaits the store LIVE
 * (see the methods below — each is a bare `return this.store.<verb>(...)`). It
 * can, because nothing here is render-read — the credentials surface is
 * Promise-typed CRUD consumed off the render path (a tool handler, a gateway
 * verb resolver), and the slot is intentionally absent from any snapshot
 * (credentials is not `SnapshotCapable`). So the taxonomy is not "every
 * store-backed harness holds a `View`", but "every SYNC-READ harness does";
 * the async-only, never-rendered harness reads the store directly. Adding a
 * `View` here would be dead weight — a cache no synchronous caller ever reads.
 *
 * ## `onChange` is the change SOURCE — cross-consumer, not self-caused
 *
 * When the adapter exposes {@link CredentialsStore.onChange}, this harness
 * forwards THAT as its change source (see the constructor) rather than
 * publishing a self-caused stream from its own `set`/`delete` callsites. That
 * is the corrected model: `onChange` observes changes to the (possibly shared)
 * store — including writes this harness did NOT originate (a sibling process
 * rotating a keychain entry, an admin pushing to KV) — so routing every change
 * through the single store seam is both complete and non-double-counting. Only
 * when the adapter has no `onChange` does the harness fall back to publishing
 * its own routed `set`/`delete` (the sole writes it can then see).
 *
 * @see CredentialsHarnessProtocol for the contract
 * @see CredentialsStore for the pluggable adapter shape
 * @see docs/proposals/v2/data-layer-plan.md §3.5 P5 (projection is conditional)
 */

import { Effect } from "effect";

import {
  BaseHarness,
  runHarnessProtocol,
  generateId,
  type BaseHarnessOptions,
  type Middleware,
} from "@agentick/runtime";
import { createNotifier, type Notifier } from "@agentick/pubsub";
import { HandlerError } from "@agentick/spec";
import type {
  CredentialsChangeEvent,
  CredentialsHarnessProtocol,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  Unsubscribe,
} from "@agentick/spec";

// The `EventScopeExtensions` augmentation this file's operation scopes depend on
// (`credentialNamespace` / `credentialKey`). Imported HERE, not only from the
// barrel, so a consumer that reaches this module directly still compiles.
import "./augment.js";
import type { CredentialsStore } from "./store.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// The two WRITE verbs are operations (ADR 92 Family 2 §7); reads stay
// data-plane. The registry key is the canonical `credentials:<verb>` form (the
// `:command:` infix `deriveHookNames` strips), so `credentials:set` mints
// `onBeforeCredentialsSet` / `onAfterCredentialsSet` and a guard sees
// `ctx.op === "CredentialsSet"`.
//
// The registered INPUT is {@link CredentialsMutationInput} — `{ namespace, key }`
// and nothing else. See the redaction law on {@link CredentialsHarness.set}.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "credentials:set": { input: CredentialsMutationInput; output: void };
    "credentials:delete": { input: CredentialsMutationInput; output: boolean };
  }
}

/**
 * The operation input for `credentials:command:{set,delete}` — the ADDRESS of a
 * credential, never its value.
 *
 * This type IS the redaction law (ADR 92 Family 2 §7). Because the secret is
 * not a field here, it cannot reach the journal, the bus, a guard, a middleware,
 * or an `onBefore…` hook: there is no post-hoc scrubbing pass to forget to run,
 * and no way for a future field to leak one in without editing this interface.
 * The value travels as a closure argument on the operation BODY instead — see
 * {@link CredentialsHarness.set}.
 */
export interface CredentialsMutationInput {
  readonly namespace: string;
  readonly key: string;
}

/**
 * `extends BaseHarnessOptions` so every slot the base accepts — `parentScope`,
 * `principal`, telemetry, metadata, the interceptor fold — arrives without being
 * re-declared here and re-forwarded by hand. Standing alone, this interface
 * silently dropped every base option a caller passed, and the next thing the base
 * gains would be dropped the same way.
 */
export interface CredentialsHarnessOptions extends BaseHarnessOptions {
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83) — the installing
   * host's interceptors, folded in at construction so app-scope guards wrap
   * credential writes. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4). Keeps inheritance live so a LATER
   * `app.guard()` reaches this harness's ops, not just the construction
   * snapshot.
   */
  readonly interceptorParent?: BaseHarness;
}

export class CredentialsHarness
  extends BaseHarness<"credentials">
  implements CredentialsHarnessProtocol
{
  private readonly store: CredentialsStore;
  private readonly changes: Notifier<CredentialsChangeEvent>;
  private storeUnsubscribe: Unsubscribe | undefined;
  private closed = false;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    store: CredentialsStore,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: CredentialsHarnessOptions = {},
  ) {
    // Forward the WHOLE bag: nothing to enumerate, so nothing to forget. Every
    // hand-picked `super({ inheritedInterceptors, interceptorParent })` was a place
    // a new base option would silently vanish — and `parentScope` did exactly that.
    super("credentials", scopeId, journal, bus, inbox, options);
    this.store = store;
    this.changes = createNotifier<CredentialsChangeEvent>();

    // If the adapter natively observes external changes (keychain
    // rotation via FS events, KV change streams, in-memory dispatch),
    // forward those into our notifier so subscribers see them with
    // the same shape as internal writes. Adapters that don't support
    // reactivity simply rely on our own set/delete callsites to
    // publish.
    if (store.onChange) {
      this.storeUnsubscribe = store.onChange((ev) => {
        if (this.closed) return;
        this.changes.notify({ namespace: ev.namespace, key: ev.key });
      });
    }
  }

  // ── Public surface — protocol-typed CRUD ────────────────────────

  // READS are data-plane (ADR 92's exclusion list) and stay plain async: they
  // are consumed off the render / fiber path (a tool handler, a gateway verb
  // resolver), so they thread the BASE `storeCtx()` — construction-slot scope
  // (sessionId + principal), no live op-fiber to enrich `opId` from. An
  // identity-aware adapter reads `ctx.principal` to resolve the right secret.
  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.store.get<T>(namespace, key, this.storeCtx());
  }

  /**
   * Write a credential — the `credentials:command:set` OPERATION (ADR 92
   * Family 2 §7). Security state-mutation, so it carries the same envelope its
   * sibling `state:set` has always had: guards, `onBeforeCredentialsSet` /
   * `onAfterCredentialsSet`, a journal record, a span.
   *
   * ## The redaction law — structural, not post-hoc
   *
   * The operation's input is `{ namespace, key }` ({@link
   * CredentialsMutationInput}). `value` is NOT an operation input; it is a
   * closure argument on the body below. That is deliberate and is the whole
   * mechanism: the journal record, the bus envelope, every middleware, and
   * every guard observe the operation's input, so a secret that was never IN
   * the input cannot be journaled, broadcast, or handed to adopter code — there
   * is no scrubbing pass that could be skipped, misconfigured, or outrun by a
   * new field. "Journal the fact and the key, never the secret"
   * (`credentials-never-cross-the-wire`, extended to the audit trail).
   *
   * The corollary is that `set` is deliberately NOT inbox-addressable: a
   * credential has no serializable command form, so the verb is declared via
   * `runOperation` + the `CommandRegistry` hook surface rather than
   * `BaseHarness.command()` (which would make the input a wire payload). A
   * remote caller drives credential lifecycle through wire-extension VERBS that
   * resolve server-side, never by shipping the material.
   *
   * The body runs inside a live operation fiber, so it threads the ENRICHED
   * {@link BaseHarness.storeCtxEffect} — the store sees this write's `opId`,
   * `parentOpId`, `correlationId`, and `traceparent`, which reads cannot offer.
   */
  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await runHarnessProtocol(
      this.mutationOp("set", { namespace, key }, () =>
        Effect.gen(this, function* () {
          const ctx = yield* this.storeCtxEffect();
          yield* Effect.tryPromise({
            try: () => this.store.set(namespace, key, value, ctx),
            catch: (cause: unknown) => cause,
          });
          // If the store natively notifies, the forwarder fires; avoid
          // double-publishing. Otherwise publish ourselves.
          if (!this.store.onChange) {
            this.changes.notify({ namespace, key });
          }
        }),
      ),
    );
  }

  /**
   * Remove a credential — the `credentials:command:delete` OPERATION (ADR 92
   * Family 2 §7). Same envelope and the same `{ namespace, key }` input as
   * {@link set}; the output (`true` when a real key was removed) is the fact
   * worth auditing.
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    return runHarnessProtocol(
      this.mutationOp("delete", { namespace, key }, () =>
        Effect.gen(this, function* () {
          const ctx = yield* this.storeCtxEffect();
          const removed = yield* Effect.tryPromise({
            try: () => this.store.delete(namespace, key, ctx),
            catch: (cause: unknown) => cause,
          });
          if (removed && !this.store.onChange) {
            this.changes.notify({ namespace, key });
          }
          return removed;
        }),
      ),
    );
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.store.has(namespace, key, this.storeCtx());
  }

  async keys(namespace: string): Promise<readonly string[]> {
    return this.store.keys(namespace, this.storeCtx());
  }

  subscribe(listener: (event: CredentialsChangeEvent) => void): Unsubscribe {
    return this.changes.subscribe(listener);
  }

  protected override teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.storeUnsubscribe?.();
    this.storeUnsubscribe = undefined;
    this.changes.clear();
  }

  // ── Substrate plumbing ──────────────────────────────────────────

  /**
   * Route a credential WRITE through {@link BaseHarness.runOperation} — the
   * `sessionOp` pattern (`session/src/harness.ts`), chosen over
   * {@link BaseHarness.command} for one reason: `command()` binds the handler
   * at construction and feeds it only the declared input, which would force the
   * secret to become a command field. Here the op input stays the redacted
   * address and the body closes over the material.
   *
   * The scope carries the credential ADDRESS (`credentialNamespace` /
   * `credentialKey`, augmented onto `EventScopeExtensions` in `augment.ts`) so
   * an auditor can filter one key's mutation history out of the stream:
   *
   *     app.events({ scope: { credentialNamespace: "oauth" } })
   */
  private mutationOp<R>(
    verb: "set" | "delete",
    input: CredentialsMutationInput,
    body: () => Effect.Effect<R, unknown, never>,
  ): Effect.Effect<R, unknown, never> {
    const op: Operation<CredentialsMutationInput, R, unknown> = {
      opId: `credentials:${verb}:${generateId()}`,
      surface: "credentials",
      name: `credentials:command:${verb}`,
      scope: { credentialNamespace: input.namespace, credentialKey: input.key },
      input,
    };
    return this.runOperation(op, body);
  }

  // CredentialsHarness ships no inbox protocol in 281b.1. The
  // surface is local CRUD against a server-resident store; remote
  // drive comes through the wire-extensions framework (#280) which
  // resolves verbs at the gateway and calls into this harness directly,
  // not via the substrate inbox.
  //
  // Future audit-log / cross-node mirror could add typed messages
  // (e.g. `credentials:audit`, `credentials:rotation:advertise`) —
  // when they do, branch on `msg.type` here.
  // TODO(#281): audit-log inbox path + bus emissions.
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: `CredentialsHarness has no inbox protocol; received: ${String(
          (msg as { type?: string }).type,
        )}`,
      }),
    );
  }
}
