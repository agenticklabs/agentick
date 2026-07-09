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
 *   Async surface  — set / delete. Declared commands (ADR 51): each
 *                     runs through `runOperation` with canonical
 *                     naming; the terminal envelope IS the change-event
 *                     audit; the same verbs are inbox-addressable over
 *                     `state:{scopeId}` (`"state:set"` / `"state:delete"`)
 *                     with zero routing code.
 *
 * Snapshot/restore — `exportSnapshot()` / `importSnapshot()` round-trip
 * the entries. Used by SnapshotHarness for hibernate/resume.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  StateDeleteInput,
  StateHarnessProtocol,
  StateSetInput,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";

export class StateHarness extends BaseHarness<"state"> implements StateHarnessProtocol {
  private readonly values = new Map<string, unknown>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns construction, routing, and enumeration.
   */
  readonly set: (input: StateSetInput) => Promise<void>;
  readonly delete: (input: StateDeleteInput) => Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("state", scopeId, journal, bus, inbox);
    const scope = () => ({ sessionId: this.scopeId });
    this.set = this.command({
      name: "state:set",
      scope,
      handler: (i: StateSetInput) => Effect.sync(() => this.applySet(i)),
    });
    this.delete = this.command({
      name: "state:delete",
      scope,
      handler: (i: StateDeleteInput) => Effect.sync(() => this.applyDelete(i)),
    });
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

  /**
   * `state:set` / `state:delete` are declared commands — routed by the
   * BaseHarness command registry before this fallthrough. Only unknown
   * types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown state message type: ${msg.type}` }));
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

  // TODO(state-deltas): project a `state` snapshot+delta channel like
  // KnobsHarness does (packages-next/knobs/src/channel.ts, ADR 73). The
  // per-key notification here IS the delta source: `applySet` → an
  // `add`/`replace` op, `applyDelete` → a `remove` op, `importSnapshot` →
  // a full snapshot frame; consumers apply with `applyJsonPatch`. Same
  // shape as knobs — a shared "SnapshotCapable reactive harness emits
  // snapshot+deltas from its change notification" mixin would DRY the two.
}
