/**
 * `SkillsHarnessProtocol` — durable, searchable library of agent
 * skills. OpenClaw / Hermes style: when the agent solves a hard
 * problem, it writes a reusable skill document so it never forgets
 * how. Skills are searchable, shareable, persist across sessions.
 *
 * Shape: full harness (per ADR 32 §Shape 1).
 *   - Audit envelopes for skill register / update / invoke / remove
 *   - Persistent state via journal — skills survive session close
 *   - Swappable backend (in-memory, sqlite-backed, agentskills.io
 *     remote registry) via the protocol
 *   - Multi-tenant scoping via per-session substrate factories
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import type { Effect } from "effect";
import type { JournalError } from "../data/errors.js";
import type { Unsubscribe } from "./inbox.js";

// ============================================================================
// Skill data model
// ============================================================================

/**
 * A skill — a named, durable, reusable capability description. The
 * agent retrieves, reads, and follows skills; admins curate the
 * library; adopters seed defaults at app construction.
 *
 * Shape inspired by Hermes Agent's skills system and the
 * `agentskills.io` open standard:
 *   - `name` is the human-readable identifier (snake_case convention)
 *   - `description` is a one-line summary the agent uses for retrieval
 *   - `content` is the full skill document — markdown, prose, or
 *     structured recipe steps
 *   - `tags` enable category-based filtering
 *   - `metadata` is adopter-defined (version, author, source URL, etc.)
 *
 * Skills are first-class data. The harness treats them as opaque
 * content; the agent's prompt design decides what to do with them.
 */
export interface Skill {
  /** Stable name (snake_case convention). Unique within the harness. */
  readonly name: string;
  /** One-line summary used for retrieval / listing. */
  readonly description: string;
  /** Full skill body — markdown / prose / recipe. */
  readonly content: string;
  /** Category tags for filtering. */
  readonly tags?: readonly string[];
  /** Adopter-defined metadata (version, author, source URL, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Wall-clock ms timestamp of last update. */
  readonly updatedAt: number;
  /** Wall-clock ms timestamp of first registration. */
  readonly createdAt: number;
}

/** Input shape for {@link SkillsHarnessProtocol.register}. */
export interface SkillsRegisterInput {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input shape for {@link SkillsHarnessProtocol.update}. */
export interface SkillsUpdateInput {
  readonly name: string;
  readonly description?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input shape for {@link SkillsHarnessProtocol.remove}. */
export interface SkillsRemoveInput {
  readonly name: string;
}

/** Filter shape for {@link SkillsHarnessProtocol.search}. */
export interface SkillsSearchInput {
  /**
   * Substring matched against `name` + `description` (case-insensitive).
   * Implementations MAY upgrade to fuzzy / embedding-based search;
   * the in-memory reference impl is substring-only.
   */
  readonly query?: string;
  /** Filter to skills carrying any of these tags (OR semantics). */
  readonly tagsAny?: readonly string[];
  /** Filter to skills carrying every one of these tags (AND semantics). */
  readonly tagsAll?: readonly string[];
  /** Cap on results. Default: implementation-defined (typically 50). */
  readonly limit?: number;
}

// ============================================================================
// Errors
// ============================================================================

export type SkillsError =
  | { readonly _tag: "SkillNotFound"; readonly name: string }
  | { readonly _tag: "SkillAlreadyExists"; readonly name: string }
  | { readonly _tag: "SkillsBackendError"; readonly cause: unknown };

// ============================================================================
// Protocol
// ============================================================================

/**
 * The skills harness protocol. Sync reads + async writes, matching
 * the canonical KnobsHarness / StateHarness pattern.
 *
 * **Sync surface** — cheap reads from local cache; no envelopes.
 * **Async surface** — full Operations through `runOperation`; every
 * mutation produces `requested → terminal` envelopes the model and
 * admins can observe.
 *
 * Implementations:
 *   - `SkillsHarness` — in-memory reference impl (this commit)
 *   - `SqliteSkillsHarness` — durable single-process backend (future)
 *   - `RemoteSkillsHarness` — `agentskills.io`-compatible remote
 *     registry (future)
 *
 * All impls satisfy the same protocol and pass the same conformance
 * suite.
 */
export interface SkillsHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;

  // ─── Sync surface (reads from local cache) ─────────────────────

  /** Look up a skill by name. */
  get(name: string): Skill | undefined;
  /** True iff a skill with this name exists. */
  has(name: string): boolean;
  /** Enumerate every skill. Stable reference between mutations. */
  list(): readonly Skill[];
  /** Substring + tag filter against the local cache. Synchronous. */
  search(input: SkillsSearchInput): readonly Skill[];
  /** Notify when a specific skill changes (register / update / remove). */
  subscribe(name: string, listener: () => void): Unsubscribe;
  /** Notify when any skill changes. */
  subscribeAll(listener: () => void): Unsubscribe;

  // ─── Async surface (full Operations through runOperation) ──────

  /** Register a new skill. Fails with `SkillAlreadyExists` on name collision. */
  register(input: SkillsRegisterInput): Promise<Skill>;
  /** Partial update on an existing skill. Fails with `SkillNotFound`. */
  update(input: SkillsUpdateInput): Promise<Skill>;
  /** Remove a skill. Idempotent — removing an unknown name is a no-op. */
  remove(input: SkillsRemoveInput): Promise<void>;

  // ─── Snapshot / restore (SnapshotCapable feature) ──────────────

  /** Export every skill for hibernate / cross-session transfer. */
  exportSnapshot(): Readonly<Record<string, Skill>>;
  /** Import a snapshot — replaces the current cache wholesale. */
  importSnapshot(snapshot: Readonly<Record<string, Skill>>): void;
}

// ============================================================================
// Inbox message catalog
// ============================================================================

/**
 * Typed inbox messages routed to a SkillsHarness instance. Cluster
 * peers, admin dashboards, sibling harnesses send these via
 * `inbox.send("skills:<scopeId>", { type, payload, messageId })`.
 */
export type SkillsInboxMessage =
  | { readonly type: "skills:register"; readonly payload: SkillsRegisterInput }
  | { readonly type: "skills:update"; readonly payload: SkillsUpdateInput }
  | { readonly type: "skills:remove"; readonly payload: SkillsRemoveInput };

// Suppress unused-import warnings when this file is consumed as a
// type-only barrel.
export type _ImportGuard = Effect.Effect<never, JournalError, never>;
