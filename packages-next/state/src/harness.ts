/**
 * StateHarness — session-internal reactive K/V storage.
 *
 * Implements {@link StateHarnessProtocol}. Extends `BaseHarness<"state">`
 * so writes participate in the substrate's Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface   — get / has / list / subscribe / subscribeAll.
 *                     Reads from local Map; no envelopes.
 *   Async surface  — set / delete. Each runs through `runOperation`;
 *                     the terminal envelope IS the change-event audit.
 *
 * Inbox routing — two message types reach the harness over its
 * address (`state:{scopeId}`):
 *
 *   - `"state:set"`    → invokes {@link set}
 *   - `"state:delete"` → invokes {@link delete}
 *
 * Snapshot/restore — `exportSnapshot()` / `importSnapshot()` round-trip
 * the entries. Used by SnapshotHarness for hibernate/resume.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol, ulid, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  StateDeleteInput,
  StateHarnessProtocol,
  StateSetInput,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";

type StateInboxMessage =
  | { readonly type: "state:set"; readonly payload: StateSetInput }
  | { readonly type: "state:delete"; readonly payload: StateDeleteInput };

export class StateHarness extends BaseHarness<"state"> implements StateHarnessProtocol {
  private readonly values = new Map<string, unknown>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  get id(): string {
    return this.scopeId;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("state", scopeId, journal, bus, inbox);
  }

  // ─────────── Sync surface ───────────

  get(key: string): unknown {
    return this.values.get(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  list(): readonly string[] {
    return [...this.values.keys()];
  }

  subscribe(key: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(key, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
  }

  // ─────────── Async surface — full Operations ───────────

  set(input: StateSetInput): Promise<void> {
    const op: Operation<StateSetInput, void, never> = {
      opId: `state:set:${ulid()}`,
      surface: "state",
      name: "state:command:set",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.applySet(i);
        }),
      ),
    );
  }

  delete(input: StateDeleteInput): Promise<void> {
    const op: Operation<StateDeleteInput, void, never> = {
      opId: `state:delete:${ulid()}`,
      surface: "state",
      name: "state:command:delete",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.applyDelete(i);
        }),
      ),
    );
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.values) out[k] = v;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, unknown>>): void {
    const oldKeys = new Set(this.values.keys());
    const newKeys = new Set(Object.keys(values));
    const changed = new Set<string>([...oldKeys, ...newKeys]);
    this.values.clear();
    for (const [k, v] of Object.entries(values)) this.values.set(k, v);
    for (const key of changed) this.fireListeners(key);
  }

  // ─────────── Inbox routing ───────────

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const m = msg as MessageEnvelope<unknown> & StateInboxMessage;
    switch (m.type) {
      case "state:set":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.set(m.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "state:delete":
        return Effect.tryPromise<void, MessageHandlerError>({
          try: () => this.delete(m.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      default:
        return Effect.fail({
          _tag: "HandlerError",
          cause: `Unknown state message type: ${(m as { type: string }).type}`,
        });
    }
  }

  // ─────────── Internals ───────────

  private applySet(input: StateSetInput): void {
    this.values.set(input.key, input.value);
    this.fireListeners(input.key);
  }

  private applyDelete(input: StateDeleteInput): void {
    if (!this.values.has(input.key)) return;
    this.values.delete(input.key);
    this.fireListeners(input.key);
  }

  private fireListeners(key: string): void {
    this.notifier.notify(key);
  }
}
