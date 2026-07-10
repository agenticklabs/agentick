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
import {
  createChangeNotifier,
  createKeyedNotifier,
  type ChangeEvent,
  type ChangeNotifier,
  type KeyedNotifier,
} from "@agentick/pubsub-next";

export class StateHarness extends BaseHarness<"state"> implements StateHarnessProtocol {
  private readonly values = new Map<string, unknown>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /**
   * The notify seam (ADR 75): typed push carrying the delta. Distinct from
   * `notifier` (bare render pings) — mutation sites emit a semantic
   * `ChangeEvent` here; projections (a future `state` snapshot+delta channel,
   * timeline events) subscribe via {@link onChange}. Values are `unknown`, so
   * add-vs-update is decided by an `existed` (`has`) check, NOT
   * `prev !== undefined` — state may legitimately store `undefined`.
   */
  private readonly changes: ChangeNotifier<unknown> = createChangeNotifier<unknown>();

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

  /**
   * Subscribe to the typed change stream (ADR 75 notify seam). Each set /
   * delete emits a `ChangeEvent` (`{ key, value?, prev? }`) carrying the
   * delta — set → add/update, delete → remove. Read-only and
   * fire-and-forget; the push twin of the bare `subscribe` render-ping.
   *
   * TODO(notify-seam): promote to `StateHarnessProtocol` when a
   * protocol-typed (cross-package) projection needs it — class-only until a
   * consumer exists.
   */
  onChange(listener: (change: ChangeEvent<unknown>) => void): Unsubscribe {
    return this.changes.onChange(listener);
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
    // `existed`, not `prev !== undefined`: state may store `undefined` as a
    // real value, so a `has` check is the exact add-vs-update discriminator.
    const existed = this.values.has(input.key);
    const prev = this.values.get(input.key);
    this.values.set(input.key, input.value);
    this.fireListeners(input.key);
    this.changes.emitChange(
      existed
        ? { key: input.key, value: input.value, prev }
        : { key: input.key, value: input.value },
    );
  }

  private applyDelete(input: StateDeleteInput): void {
    if (!this.values.has(input.key)) return;
    const prev = this.values.get(input.key);
    this.values.delete(input.key);
    this.fireListeners(input.key);
    // Remove — value omitted. `changeKind` reads this as "remove" regardless
    // of whether the stored value was itself `undefined`.
    this.changes.emitChange({ key: input.key, prev });
  }

  private fireListeners(key: string): void {
    this.notifier.notify(key);
  }

  // TODO(state-deltas): project a `state` snapshot+delta channel like
  // KnobsHarness does (packages-next/knobs/src/channel.ts, ADR 73) — but as a
  // SUBSCRIBER of `changes.onChange`, exactly as knobs' `projectStateDelta`
  // now does: `changeKind(change)` → add/replace/remove op, `importSnapshot`
  // → a full snapshot frame; consumers apply with `applyJsonPatch`. One
  // caveat for `unknown` values: a `set(key, undefined)` yields a ChangeEvent
  // whose `value` is absent, which `changeKind` classifies as "remove" — the
  // channel must special-case undefined-valued sets (emit an explicit JSON
  // `null` or a presence flag) so the far side doesn't drop the key. A shared
  // "SnapshotCapable reactive harness projects snapshot+deltas from its
  // change stream" mixin would DRY knobs + state.
}
