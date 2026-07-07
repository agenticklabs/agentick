/**
 * KnobsHarness — model-visible reactive state as a full harness.
 *
 * Implements {@link KnobsHarnessProtocol}. Extends `BaseHarness<"knobs">`
 * so its writes participate in the substrate's full Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface     — get / has / list / subscribe / subscribeAll.
 *                       Reads from local Map; no envelopes; cheap.
 *   Async surface    — set / register / dispatch. Each runs through
 *                       `runOperation`; the terminal envelope IS the
 *                       change-event audit trail.
 *
 * Inbox routing — three message types reach the harness over its
 * address (`knobs:{scopeId}`):
 *
 *   - `"knobs:set"`       → invokes {@link set}
 *   - `"knobs:register"`  → invokes {@link register}
 *   - `"knobs:dispatch"`  → invokes {@link dispatch}
 *
 * The cluster case: an admin dashboard on a remote node sends an
 * inbox message addressed to this harness; the cluster substrate
 * routes it; the handler runs the same Operation that an in-process
 * call would.
 *
 * Snapshot/restore — `exportSnapshot()` / `importSnapshot()` round-trip
 * the value cells. Descriptors are NOT snapshotted (components re-
 * declare on remount).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  ContentBlock,
  EventBus,
  KnobDescriptor,
  KnobPrimitive,
  KnobRegistration,
  KnobValueType,
  KnobsDispatchInput,
  KnobsHarnessProtocol,
  KnobsRegisterInput,
  KnobsSetInput,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";

// ============================================================================
// Harness
// ============================================================================

export class KnobsHarness extends BaseHarness<"knobs"> implements KnobsHarnessProtocol {
  private readonly values = new Map<string, KnobPrimitive>();
  private readonly descriptors = new Map<string, KnobRegistration>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /**
   * Cached snapshot for `list()`. Invalidated on every mutation so that
   * `useSyncExternalStore` consumers see stable references between
   * mutations (and a fresh reference after one).
   */
  private listCache: readonly KnobDescriptor[] | null = null;

  get id(): string {
    return this.scopeId;
  }

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns construction, inbox routing, and enumeration.
   * `set`'s body is the mutation: lifecycle handlers fire first
   * (`before` can veto), middleware wraps, the terminal envelope
   * publishes after — by resolution the value is set, listeners have
   * fired, and the audit envelope is on the bus + journal.
   * `dispatch` keeps v1 set_knob semantics: the Operation succeeds
   * either way; the result blocks distinguish validation failure from
   * successful mutation.
   */
  readonly set: (input: KnobsSetInput) => Promise<void>;
  readonly register: (input: KnobsRegisterInput) => Promise<void>;
  readonly dispatch: (input: KnobsDispatchInput) => Promise<readonly ContentBlock[]>;

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("knobs", scopeId, journal, bus, inbox);
    const scope = () => ({ sessionId: this.scopeId });
    this.set = this.command({
      name: "knobs:set",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: KnobsSetInput) => Effect.sync(() => this.applySet(i)),
    });
    this.register = this.command({
      name: "knobs:register",
      scope,
      handler: (i: KnobsRegisterInput) => Effect.sync(() => this.applyRegister(i)),
    });
    this.dispatch = this.command({
      name: "knobs:dispatch",
      scope,
      handler: (i: KnobsDispatchInput) => Effect.sync(() => this.executeDispatch(i)),
    });
  }

  // ─────────── Sync surface ───────────

  get(id: string): KnobPrimitive | undefined {
    return this.values.get(id);
  }

  has(id: string): boolean {
    return this.values.has(id);
  }

  list(): readonly KnobDescriptor[] {
    if (this.listCache !== null) return this.listCache;
    const out: KnobDescriptor[] = [];
    // Descriptor-known ids first (registration order), then value-only
    // ids (set without a prior descriptor registration).
    for (const [id, descriptor] of this.descriptors) {
      out.push({ id, value: this.values.get(id), ...descriptor });
    }
    for (const [id, value] of this.values) {
      if (this.descriptors.has(id)) continue;
      out.push({ id, value });
    }
    this.listCache = out;
    return out;
  }

  subscribe(id: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(id, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, KnobPrimitive>> {
    const out: Record<string, KnobPrimitive> = {};
    for (const [k, v] of this.values) out[k] = v;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, KnobPrimitive>>): void {
    const oldKeys = new Set(this.values.keys());
    const newKeys = new Set(Object.keys(values));
    const changed = new Set<string>([...oldKeys, ...newKeys]);
    this.values.clear();
    for (const [k, v] of Object.entries(values)) this.values.set(k, v);
    this.listCache = null;
    for (const id of changed) this.fireListeners(id);
  }

  // ─────────── Inbox routing ───────────

  /**
   * `knobs:set` / `knobs:register` / `knobs:dispatch` are declared
   * commands — routed by the BaseHarness command registry before this
   * fallthrough. Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown knobs message type: ${msg.type}` }));
  }

  // ─────────── Internals ───────────

  private applySet(input: KnobsSetInput): void {
    this.values.set(input.id, input.value);
    this.listCache = null;
    this.fireListeners(input.id);
  }

  private applyRegister(input: KnobsRegisterInput): void {
    this.descriptors.set(input.id, input.descriptor);
    if (!this.values.has(input.id) && input.descriptor.defaultValue !== undefined) {
      this.values.set(input.id, input.descriptor.defaultValue);
    }
    this.listCache = null;
    this.fireListeners(input.id);
  }

  /**
   * Validation + dispatch — matches the v1 `set_knob` tool pipeline
   * field for field: exactly-one(name, group) → exists → type → options
   * → bounds → length/pattern → custom `validate`. On failure, returns
   * an error ContentBlock array; on success, mutates + returns a
   * confirmation message.
   */
  private executeDispatch(input: KnobsDispatchInput): readonly ContentBlock[] {
    const hasName = input.name !== undefined && input.name !== "";
    const hasGroup = input.group !== undefined && input.group !== "";

    if (hasName && hasGroup) return err("Provide either name or group, not both.");
    if (!hasName && !hasGroup) return err("Provide either name or group.");

    const all = this.list();

    if (hasName) {
      const knob = all.find((k) => k.id === input.name);
      if (!knob) {
        return err(`Unknown knob "${input.name}". Available: ${all.map((k) => k.id).join(", ")}`);
      }
      if (knob.readOnly) {
        return err(
          `Knob "${knob.id}" is read-only — it is managed by the application and cannot be set.`,
        );
      }
      const reason = validateValue(knob, input.value);
      if (reason) return err(reason);
      this.applySet({ id: knob.id, value: input.value });
      return [{ type: "text", text: `Set ${knob.id} to ${fmt(input.value)}.` }];
    }

    // Group dispatch: read-only knobs are excluded from group writes;
    // type-check the remaining group first; mutate atomically.
    const members = all.filter((k) => k.group === input.group);
    const targets = members.filter((k) => !k.readOnly);
    if (targets.length === 0) {
      return err(
        members.length > 0
          ? `All knobs in group "${input.group}" are read-only — they are managed by the application and cannot be set.`
          : `No knobs found in group "${input.group}".`,
      );
    }
    const expected = targets[0]!.valueType;
    for (const t of targets) {
      if (t.valueType !== expected) {
        return err(
          `Type mismatch in group "${input.group}": "${t.id}" is ${t.valueType}, expected ${expected}.`,
        );
      }
    }
    for (const t of targets) {
      const reason = validateValue(t, input.value);
      if (reason) return err(reason);
    }
    for (const t of targets) this.applySet({ id: t.id, value: input.value });
    const names = targets.map((t) => t.id).join(", ");
    return [
      {
        type: "text",
        text: `Set ${targets.length} knobs in group "${input.group}" to ${fmt(input.value)}: ${names}.`,
      },
    ];
  }

  private fireListeners(id: string): void {
    this.notifier.notify(id);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function err(text: string): readonly ContentBlock[] {
  return [{ type: "text", text }];
}

function fmt(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function validateValue(desc: KnobDescriptor, value: KnobPrimitive): string | null {
  const expected: KnobValueType | undefined = desc.valueType;
  if (expected && typeof value !== expected) {
    return `Invalid type for "${desc.id}". Expected ${expected}, got ${typeof value}.`;
  }
  if (desc.options && desc.options.length > 0 && !desc.options.some((o) => o === value)) {
    return `Invalid value for "${desc.id}". Valid options: ${desc.options.map(fmt).join(", ")}`;
  }
  if (typeof value === "number") {
    if (desc.min !== undefined && value < desc.min) {
      return `Value for "${desc.id}" must be >= ${desc.min}. Got ${value}.`;
    }
    if (desc.max !== undefined && value > desc.max) {
      return `Value for "${desc.id}" must be <= ${desc.max}. Got ${value}.`;
    }
  }
  if (typeof value === "string") {
    if (desc.maxLength !== undefined && value.length > desc.maxLength) {
      return `Value for "${desc.id}" exceeds max length of ${desc.maxLength}. Got ${value.length} chars.`;
    }
    if (desc.pattern !== undefined && !new RegExp(desc.pattern).test(value)) {
      return `Value for "${desc.id}" does not match pattern: ${desc.pattern}`;
    }
  }
  if (desc.validate) {
    const result = desc.validate(value);
    if (result !== true) return `Validation failed for "${desc.id}": ${result}`;
  }
  return null;
}
