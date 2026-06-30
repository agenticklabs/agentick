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
 * @see CredentialsHarnessProtocol for the contract
 * @see CredentialsStore for the pluggable adapter shape
 */

import { Effect } from "effect";

import { BaseHarness } from "@agentick/runtime-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";
import { HandlerError } from "@agentick/spec-next";
import type {
  CredentialsChangeEvent,
  CredentialsHarnessProtocol,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  Unsubscribe,
} from "@agentick/spec-next";

import type { CredentialsStore } from "./store.js";

// `CredentialsHarnessOptions` is intentionally empty in 281b.1. Future
// slots (e.g. `parentScope` for projecting `{ appId, gatewayId }` onto
// audit-log bus envelopes) land alongside the consumer that needs
// them — no preemptive dead fields.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CredentialsHarnessOptions {}

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: CredentialsHarnessOptions = {},
  ) {
    super("credentials", scopeId, journal, bus, inbox);
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

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.store.get<T>(namespace, key);
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.store.set(namespace, key, value);
    // If the store natively notifies, the forwarder fires; avoid
    // double-publishing. Otherwise publish ourselves.
    if (!this.store.onChange) {
      this.changes.notify({ namespace, key });
    }
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const removed = await this.store.delete(namespace, key);
    if (removed && !this.store.onChange) {
      this.changes.notify({ namespace, key });
    }
    return removed;
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.store.has(namespace, key);
  }

  async keys(namespace: string): Promise<readonly string[]> {
    return this.store.keys(namespace);
  }

  subscribe(listener: (event: CredentialsChangeEvent) => void): Unsubscribe {
    return this.changes.subscribe(listener);
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.storeUnsubscribe?.();
    this.storeUnsubscribe = undefined;
    this.changes.clear();
    await super.close();
  }

  // ── Substrate plumbing ──────────────────────────────────────────

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
