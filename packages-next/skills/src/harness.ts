/**
 * `SkillsHarness` — durable library of agent skills.
 *
 * Per ADR 32, this is a Shape 1 harness extension:
 *   - Audit envelopes for every register / update / remove
 *   - Snapshot/restore via `SnapshotCapable` feature detection
 *   - Inbox-addressable for cross-actor mutations (cluster peers,
 *     admin dashboards, sibling harnesses) — all three verbs are
 *     declared commands (ADR 51): `skills:register` / `skills:update`
 *     / `skills:remove` route through the BaseHarness command
 *     registry with zero routing code
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * In-memory reference impl. Durable backends (sqlite, remote
 * `agentskills.io` registry) implement the same protocol and pass
 * the same conformance suite.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see packages/spec/src/protocol/skills-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  Skill,
  SkillsError,
  SkillsHarnessProtocol,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
} from "@agentick/spec-next";
import { HandlerError, SkillAlreadyExists, SkillNotFound } from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

import type { SkillLoader } from "./loaders.js";

function skillContentChanged(existing: Skill, incoming: SkillsRegisterInput): boolean {
  if (existing.description !== incoming.description) return true;
  if (existing.content !== incoming.content) return true;
  const existingTags = existing.tags ? [...existing.tags].sort().join("|") : "";
  const incomingTags = incoming.tags ? [...incoming.tags].sort().join("|") : "";
  if (existingTags !== incomingTags) return true;
  return false;
}

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

  /**
   * Loaders retained from `withSkills({ loaders })`. Drive
   * post-startup `reload()` + `resolve(name)` (lookup-on-miss).
   * Empty when no loaders were configured.
   */
  private loaders: readonly SkillLoader[] = [];

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns Operation construction, inbox routing, and
   * enumeration. All three inputs are serializable data, so every
   * skills verb is addressable (no function-carrying operations stay
   * hand-built here). Payloads carried no validation before the
   * registry; schemas stay off for parity.
   */
  readonly register: (input: SkillsRegisterInput) => Promise<Skill>;
  readonly update: (input: SkillsUpdateInput) => Promise<Skill>;
  readonly remove: (input: SkillsRemoveInput) => Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super(SURFACE, scopeId, journal, bus, inbox);
    const scope = () => ({ sessionId: this.scopeId });
    this.register = this.command({
      name: "skills:register",
      scope,
      handler: (i: SkillsRegisterInput) => this.applyRegister(i),
    });
    this.update = this.command({
      name: "skills:update",
      scope,
      handler: (i: SkillsUpdateInput) => this.applyUpdate(i),
    });
    this.remove = this.command({
      name: "skills:remove",
      scope,
      handler: (i: SkillsRemoveInput) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
    });
  }

  /**
   * Replace the loader set used by `reload()` and `resolve()`.
   * Called by `withSkills` at install time; adopters can also swap the
   * loader set at runtime (e.g., add a new source after startup).
   */
  setLoaders(loaders: readonly SkillLoader[]): void {
    this.loaders = loaders;
  }

  // ─────────── Dynamic surface ───────────

  /**
   * Re-run every configured loader, diff against current state, apply
   * adds + updates (and removes when `pruneMissing: true`). Loader
   * errors propagate — wrap individual loaders if you need fallback.
   *
   * Returns a summary of names touched.
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    const batches = await Promise.all(this.loaders.map((l) => l.load()));
    const fresh = new Map<string, SkillsRegisterInput>();
    for (const batch of batches) {
      for (const skill of batch) fresh.set(skill.name, skill);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const [name, record] of fresh) {
      if (this.skills.has(name)) {
        const existing = this.skills.get(name)!;
        if (skillContentChanged(existing, record)) {
          await this.update({
            name,
            description: record.description,
            content: record.content,
            ...(record.tags ? { tags: record.tags } : {}),
            ...(record.metadata ? { metadata: record.metadata } : {}),
          });
          updated.push(name);
        }
      } else {
        await this.register(record);
        added.push(name);
      }
    }
    const removed: string[] = [];
    if (opts.pruneMissing) {
      for (const name of Array.from(this.skills.keys())) {
        if (!fresh.has(name)) {
          await this.remove({ name });
          removed.push(name);
        }
      }
    }
    return { added, updated, removed };
  }

  /**
   * Lookup-on-miss: returns the registered skill if present; otherwise
   * asks each loader (via `lookup` or `load()` + filter) and registers
   * the first match. Returns `null` if no loader has the name.
   */
  async resolve(name: string): Promise<Skill | null> {
    const existing = this.skills.get(name);
    if (existing) return existing;
    for (const loader of this.loaders) {
      const found = loader.lookup
        ? await loader.lookup(name)
        : ((await loader.load()).find((s) => s.name === name) ?? null);
      if (found) {
        await this.register(found);
        return this.skills.get(name) ?? null;
      }
    }
    return null;
  }

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `SkillNotFound`-tagged error instead of returning `null` when
   * no loader has the name. Use when the absence of a name is a
   * programming error (must-exist contract), not a domain case.
   */
  async require(name: string): Promise<Skill> {
    const resolved = await this.resolve(name);
    if (resolved !== null) return resolved;
    throw new SkillNotFound({ name });
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

  // ─────────── Inbox routing ───────────

  /**
   * `skills:register` / `skills:update` / `skills:remove` are declared
   * commands — routed by the BaseHarness command registry before this
   * fallthrough. Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown skills message type: ${msg.type}` }));
  }

  // ─────────── Private mutation helpers ───────────

  private applyRegister(input: SkillsRegisterInput): Effect.Effect<Skill, SkillsError, never> {
    return Effect.suspend((): Effect.Effect<Skill, SkillsError, never> => {
      if (this.skills.has(input.name)) {
        return Effect.fail(new SkillAlreadyExists({ name: input.name }));
      }
      const now = Date.now();
      const skill: Skill = {
        name: input.name,
        description: input.description,
        content: input.content,
        ...omitUndefined({ tags: input.tags, metadata: input.metadata }),
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
        return Effect.fail(new SkillNotFound({ name: input.name }));
      }
      const updated: Skill = {
        ...existing,
        ...omitUndefined({
          description: input.description,
          content: input.content,
          tags: input.tags,
        }),
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
