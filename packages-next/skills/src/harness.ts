/**
 * `SkillsHarness` — durable library of agent skills.
 *
 * Per ADR 32, this is a Shape 1 harness extension:
 *   - Audit envelopes for every register / update / remove
 *   - Snapshot/restore via `SnapshotCapable` feature detection
 *   - Inbox-addressable for cross-actor mutations (cluster peers,
 *     admin dashboards, sibling harnesses)
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * In-memory reference impl. Durable backends (sqlite, remote
 * `agentskills.io` registry) implement the same protocol and pass
 * the same conformance suite.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see packages/spec/src/protocol/skills-harness.ts
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
  Skill,
  SkillsError,
  SkillsHarnessProtocol,
  SkillsInboxMessage,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";

// ============================================================================
// Harness
// ============================================================================

const SURFACE = "skills" as const;

// `skills` is not in the EventSurface union yet — add it via a cast
// at construction; spec-level addition is a one-line follow-up. For
// now we declare locally as the surface tag used by BaseHarness.
type SkillsSurface = typeof SURFACE;

export class SkillsHarness extends BaseHarness<SkillsSurface> implements SkillsHarnessProtocol {
  private readonly skills = new Map<string, Skill>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /** Cached snapshot for `list()`. Invalidated on every mutation. */
  private listCache: readonly Skill[] | null = null;

  get id(): string {
    return this.scopeId;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super(SURFACE, scopeId, journal, bus, inbox);
  }

  // ─────────── Sync surface ───────────

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): readonly Skill[] {
    if (this.listCache !== null) return this.listCache;
    const out: Skill[] = Array.from(this.skills.values());
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.listCache = out;
    return out;
  }

  search(input: SkillsSearchInput): readonly Skill[] {
    const q = input.query?.toLowerCase();
    const tagsAny = input.tagsAny;
    const tagsAll = input.tagsAll;
    const limit = input.limit ?? 50;
    const out: Skill[] = [];

    for (const skill of this.list()) {
      // Query: substring against name + description.
      if (q) {
        const hay = `${skill.name.toLowerCase()} ${skill.description.toLowerCase()}`;
        if (!hay.includes(q)) continue;
      }
      // tagsAny: must carry at least one named tag.
      if (tagsAny && tagsAny.length > 0) {
        const skillTags = skill.tags ?? [];
        if (!tagsAny.some((t) => skillTags.includes(t))) continue;
      }
      // tagsAll: must carry every named tag.
      if (tagsAll && tagsAll.length > 0) {
        const skillTags = skill.tags ?? [];
        if (!tagsAll.every((t) => skillTags.includes(t))) continue;
      }
      out.push(skill);
      if (out.length >= limit) break;
    }
    return out;
  }

  subscribe(name: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(name, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
  }

  // ─────────── Async surface — full Operations ───────────

  register(input: SkillsRegisterInput): Promise<Skill> {
    const op: Operation<SkillsRegisterInput, Skill, SkillsError> = {
      opId: `skills:register:${ulid()}`,
      surface: SURFACE,
      name: "skills:command:register",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyRegister(i)));
  }

  update(input: SkillsUpdateInput): Promise<Skill> {
    const op: Operation<SkillsUpdateInput, Skill, SkillsError> = {
      opId: `skills:update:${ulid()}`,
      surface: SURFACE,
      name: "skills:command:update",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyUpdate(i)));
  }

  remove(input: SkillsRemoveInput): Promise<void> {
    const op: Operation<SkillsRemoveInput, void, never> = {
      opId: `skills:remove:${ulid()}`,
      surface: SURFACE,
      name: "skills:command:remove",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
      ),
    );
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, Skill>> {
    const out: Record<string, Skill> = {};
    for (const [k, v] of this.skills) out[k] = v;
    return out;
  }

  importSnapshot(snapshot: Readonly<Record<string, Skill>>): void {
    this.skills.clear();
    for (const [k, v] of Object.entries(snapshot)) this.skills.set(k, v);
    this.listCache = null;
    // Snapshot import: wildcard-only signal so global views refresh
    // without per-id firings flooding.
    this.notifier.notifyAll();
  }

  // ─────────── Inbox handler ───────────

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // The inbox typing erases the payload's concrete shape (`unknown`).
    // We discriminate on `msg.type` then narrow the payload via the
    // SkillsInboxMessage catalog.
    const inbound = { type: msg.type, payload: msg.payload } as SkillsInboxMessage;
    switch (inbound.type) {
      case "skills:register":
        return Effect.tryPromise({
          try: () => this.register(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "skills:update":
        return Effect.tryPromise({
          try: () => this.update(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "skills:remove":
        return Effect.tryPromise({
          try: () => this.remove(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      default:
        return Effect.fail({
          _tag: "InvalidPayload",
          reason: `Unknown skills inbox message type: ${msg.type}`,
        } satisfies MessageHandlerError);
    }
  }

  // ─────────── Private mutation helpers ───────────

  private applyRegister(input: SkillsRegisterInput): Effect.Effect<Skill, SkillsError, never> {
    return Effect.suspend((): Effect.Effect<Skill, SkillsError, never> => {
      if (this.skills.has(input.name)) {
        return Effect.fail({ _tag: "SkillAlreadyExists", name: input.name });
      }
      const now = Date.now();
      const skill: Skill = {
        name: input.name,
        description: input.description,
        content: input.content,
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        createdAt: now,
        updatedAt: now,
      };
      this.skills.set(input.name, skill);
      this.invalidateAndNotify(input.name);
      return Effect.succeed(skill);
    });
  }

  private applyUpdate(input: SkillsUpdateInput): Effect.Effect<Skill, SkillsError, never> {
    return Effect.suspend((): Effect.Effect<Skill, SkillsError, never> => {
      const existing = this.skills.get(input.name);
      if (!existing) {
        return Effect.fail({ _tag: "SkillNotFound", name: input.name });
      }
      const updated: Skill = {
        ...existing,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.metadata !== undefined
          ? { metadata: { ...(existing.metadata ?? {}), ...input.metadata } }
          : {}),
        updatedAt: Date.now(),
      };
      this.skills.set(input.name, updated);
      this.invalidateAndNotify(input.name);
      return Effect.succeed(updated);
    });
  }

  private applyRemove(input: SkillsRemoveInput): void {
    if (this.skills.delete(input.name)) {
      this.invalidateAndNotify(input.name);
    }
    // Idempotent — remove of unknown name is a no-op (no error).
  }

  private invalidateAndNotify(name: string): void {
    this.listCache = null;
    this.notifier.notify(name);
  }
}
