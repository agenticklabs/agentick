/**
 * `CredentialsHarness` — one harness, many providers (ADR 107).
 *
 * The harness owns the substrate concerns — lifecycle, the namespace-scoped
 * bridge, reactive change fan-out, the journaled write ops. A
 * {@link CredentialProvider} owns one namespace's resolution, and the harness
 * routes to it on exact namespace match.
 *
 * Structurally this mirrors the connectors harness: a registry of named specs
 * with `register` / `unregister` / `start` / `stop`, rather than one backend
 * passed to the constructor. A real deployment needs several sources at once —
 * a token store here, an on-demand minter there — and under a single-backend
 * design one implementation had to demultiplex namespaces internally.
 *
 * ## What never happens here
 *
 * - **No inbox protocol.** Credentials are server-resident; an inbox verb would
 *   be a network-reachable secret read. {@link handleMessage} refuses.
 * - **No credential value on any event or scope.** Writes journal the
 *   COORDINATES (`credentialNamespace` / `credentialKey`); change notifications
 *   carry the same. A diagnostic subscriber never sees material it did not
 *   explicitly read.
 * - **No silent shadowing.** A namespace has exactly one provider; a second
 *   claim is {@link DuplicateCredentialNamespace}.
 *
 * @see docs/proposals/v2/blueprint/107-credentials-as-builtin.md
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
import type { CredentialProvider } from "./provider.js";
import {
  CredentialOperationUnsupported,
  DuplicateCredentialNamespace,
  UnknownCredentialNamespace,
} from "./errors.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// WRITE verbs and registry mutations are operations (ADR 92 Family 2 §7); reads
// stay data-plane. The registry key is the canonical `credentials:<verb>` form
// (the `:command:` infix `deriveHookNames` strips), so `credentials:set` mints
// `onBeforeCredentialsSet` / `onAfterCredentialsSet` and a guard sees the write
// before it lands.

declare module "@agentick/runtime" {
  interface CommandRegistry {
    "credentials:set": { input: CredentialsMutationInput; output: void };
    "credentials:delete": { input: CredentialsMutationInput; output: boolean };
    "credentials:register": { input: CredentialsRegistryInput; output: void };
    "credentials:unregister": { input: CredentialsRegistryInput; output: void };
    "credentials:start": { input: CredentialsRegistryInput; output: void };
    "credentials:stop": { input: CredentialsRegistryInput; output: void };
  }
}

export interface CredentialsMutationInput {
  readonly namespace: string;
  readonly key: string;
}

export interface CredentialsRegistryInput {
  readonly namespace: string;
}

export interface CredentialsHarnessOptions extends BaseHarnessOptions<unknown, "credentials"> {
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  readonly interceptorParent?: BaseHarness;
  /** Providers registered at construction — equivalent to `register` on each. */
  readonly providers?: readonly CredentialProvider[];
}

export class CredentialsHarness
  extends BaseHarness<"credentials">
  implements CredentialsHarnessProtocol
{
  private readonly providers = new Map<string, CredentialProvider>();
  private readonly providerUnsubscribes = new Map<string, Unsubscribe>();
  private readonly changes: Notifier<CredentialsChangeEvent>;
  private closed = false;

  get id(): string {
    return this.scopeId;
  }

  /** Namespaces with a provider, in registration order. */
  get namespaces(): readonly string[] {
    return [...this.providers.keys()];
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: CredentialsHarnessOptions = {},
  ) {
    super("credentials", scopeId, journal, bus, inbox, options);
    this.changes = createNotifier<CredentialsChangeEvent>();
    for (const provider of options.providers ?? []) this.attach(provider);
  }

  // ── Registry ──────────────────────────────────────────────────────────────

  /**
   * Claim a namespace. Journaled, so an audit hook sees a credential SOURCE
   * appear — which matters as much as seeing a read.
   */
  async register(provider: CredentialProvider): Promise<void> {
    // Refused BEFORE the op: claiming a taken namespace is a composition bug,
    // and the caller should see the typed error rather than an operation
    // failure wrapping it.
    if (this.providers.has(provider.namespace)) {
      throw new DuplicateCredentialNamespace(provider.namespace);
    }
    await runHarnessProtocol(
      this.registryOp("register", { namespace: provider.namespace }, () =>
        Effect.sync(() => {
          this.attach(provider);
        }),
      ),
    );
  }

  async unregister(namespace: string): Promise<void> {
    await runHarnessProtocol(
      this.registryOp("unregister", { namespace }, () =>
        Effect.promise(async () => {
          const provider = this.providers.get(namespace);
          if (provider === undefined) return;
          await provider.stop?.();
          this.providerUnsubscribes.get(namespace)?.();
          this.providerUnsubscribes.delete(namespace);
          this.providers.delete(namespace);
        }),
      ),
    );
  }

  /** Acquire whatever backs a provider — a connection, a minting client. */
  async start(namespace: string): Promise<void> {
    await runHarnessProtocol(
      this.registryOp("start", { namespace }, () =>
        Effect.promise(async () => {
          await this.require(namespace).start?.();
        }),
      ),
    );
  }

  async stop(namespace: string): Promise<void> {
    await runHarnessProtocol(
      this.registryOp("stop", { namespace }, () =>
        Effect.promise(async () => {
          await this.require(namespace).stop?.();
        }),
      ),
    );
  }

  /** Start every registered provider — the slot calls this once at boot. */
  async startAll(): Promise<void> {
    for (const namespace of this.namespaces) await this.start(namespace);
  }

  // ── Reads — data-plane, not operations ────────────────────────────────────

  // READS are data-plane (ADR 92's exclusion list) and stay plain async: they
  // are consumed off the render / fiber path (a tool's host-bound port, a
  // gateway verb resolver), so they thread the BASE `storeCtx()` —
  // construction-slot scope (sessionId + principal), no live op-fiber to enrich
  // `opId` from. A provider reads `ctx.principal` to decide what this caller may
  // resolve.

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.require(namespace).get<T>(key, this.storeCtx());
  }

  async has(namespace: string, key: string): Promise<boolean> {
    const provider = this.require(namespace);
    if (provider.has) return provider.has(key, this.storeCtx());
    return (await provider.get(key, this.storeCtx())) !== undefined;
  }

  async keys(namespace: string): Promise<readonly string[]> {
    const provider = this.require(namespace);
    if (!provider.keys) {
      throw new CredentialOperationUnsupported(namespace, "keys", provider.backend);
    }
    return provider.keys(this.storeCtx());
  }

  // ── Writes — journaled operations ─────────────────────────────────────────

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await runHarnessProtocol(
      this.mutationOp("set", { namespace, key }, () =>
        Effect.gen(this, function* () {
          const provider = this.require(namespace);
          const write = provider.set;
          if (!write) {
            return yield* Effect.fail(
              new CredentialOperationUnsupported(namespace, "set", provider.backend),
            );
          }
          const ctx = yield* this.storeCtxEffect();
          yield* Effect.tryPromise({
            try: () => write.call(provider, key, value, ctx),
            catch: (cause: unknown) => cause,
          });
          if (!provider.onChange) this.changes.notify({ namespace, key });
        }),
      ),
    );
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return runHarnessProtocol(
      this.mutationOp("delete", { namespace, key }, () =>
        Effect.gen(this, function* () {
          const provider = this.require(namespace);
          const remove = provider.delete;
          if (!remove) {
            return yield* Effect.fail(
              new CredentialOperationUnsupported(namespace, "delete", provider.backend),
            );
          }
          const ctx = yield* this.storeCtxEffect();
          const removed = yield* Effect.tryPromise({
            try: () => remove.call(provider, key, ctx),
            catch: (cause: unknown) => cause,
          });
          if (removed && !provider.onChange) this.changes.notify({ namespace, key });
          return removed;
        }),
      ),
    );
  }

  subscribe(listener: (event: CredentialsChangeEvent) => void): Unsubscribe {
    return this.changes.subscribe(listener);
  }

  protected override teardown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.providerUnsubscribes.values()) unsubscribe();
    for (const provider of this.providers.values()) void provider.stop?.();
    this.providerUnsubscribes.clear();
    this.providers.clear();
    this.changes.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Registration proper, shared by the constructor and the `register` command.
   * A namespace has exactly one provider: shadowing one is never implicit, and
   * the journaled `credentialNamespace` identifies which provider served a read
   * only while that holds.
   */
  private attach(provider: CredentialProvider): void {
    if (this.providers.has(provider.namespace)) {
      throw new DuplicateCredentialNamespace(provider.namespace);
    }
    this.providers.set(provider.namespace, provider);
    const watch = provider.onChange;
    if (watch) {
      this.providerUnsubscribes.set(
        provider.namespace,
        watch.call(provider, (key: string) => {
          if (this.closed) return;
          this.changes.notify({ namespace: provider.namespace, key });
        }),
      );
    }
  }

  /**
   * Route, or refuse. An unregistered namespace means the deployment wired no
   * source for these credentials — a composition bug, distinct from a key that
   * is simply absent, which is a plain `undefined`.
   */
  private require(namespace: string): CredentialProvider {
    const provider = this.providers.get(namespace);
    if (provider === undefined) {
      throw new UnknownCredentialNamespace(namespace, this.namespaces);
    }
    return provider;
  }

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

  private registryOp<R>(
    verb: "register" | "unregister" | "start" | "stop",
    input: CredentialsRegistryInput,
    body: () => Effect.Effect<R, unknown, never>,
  ): Effect.Effect<R, unknown, never> {
    const op: Operation<CredentialsRegistryInput, R, unknown> = {
      opId: `credentials:${verb}:${generateId()}`,
      surface: "credentials",
      name: `credentials:command:${verb}`,
      scope: { credentialNamespace: input.namespace },
      input,
    };
    return this.runOperation(op, body);
  }

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
