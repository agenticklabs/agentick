/**
 * `SkillsHandle` — the user-facing surface of the skills harness as
 * exposed on `session.skills`.
 *
 * Curated subset of {@link SkillsHarnessProtocol}: hides `id`,
 * `ready`, `close`, snapshot import/export. Adopters read, register,
 * update, remove, search, and subscribe.
 *
 * Structural subset — no runtime wrapping. The harness class IS a
 * structural `SkillsHandle` because it satisfies the same method
 * shape.
 *
 * @see ./augment.ts (module augmentation onto `SessionHarnessProtocol`)
 */

import type {
  SendInput,
  SessionExecutionHandle,
  Skill,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
  StandardSchemaV1,
  Unsubscribe,
} from "@agentick/spec-next";

/**
 * Options for {@link SkillsHandle.run} (three-audiences-plan §C).
 *
 * A skill run is a `session.send` primed with the skill's content — the model
 * is the executor; the skill stays non-executable data. `output` rides the
 * structured-output path (§B2): the send derives a synthetic terminal tool (or
 * a `responseFormat` overlay on a bare send), and the validated value lands in
 * `SendResult.data`.
 */
export interface SkillRunOptions<T = unknown> {
  /**
   * Arguments handed to the skill. Serialized into the run's user message by
   * the default composition (JSON). A `composeRun` seam override may shape
   * them differently.
   */
  readonly args?: Record<string, unknown>;
  /**
   * Structured-output schema (§B2). A `StandardSchemaV1` (Zod, Valibot,
   * `jsonSchema()`, …); threaded to `SendInput.output`. The validated value is
   * returned as `SendResult.data`. Omit for a text-only run.
   *
   * A run carrying `output` that RACES an in-flight execution takes the
   * steer-join path and is rejected with `SteerCannotCarryStructuredOutput`
   * (an in-flight join has no final turn of its own to shape) — the existing
   * guard, surfaced here honestly, not a new one.
   */
  readonly output?: StandardSchemaV1<unknown, T>;
  /** Override the send's max tick bound. */
  readonly maxTicks?: number;
  /** Per-run abort, threaded to the send. */
  readonly signal?: AbortSignal;
  /**
   * Run the skill in isolation (a fork of the current session) instead of
   * inline. NOT YET AVAILABLE — C-core is inline-only; `true` rejects with
   * `SkillIsolationUnavailable` naming the C2 fork follow-up, never silently
   * running inline.
   */
  readonly isolate?: boolean;
}

/**
 * The run-composition seam (`withSkills({ composeRun })`). Maps a resolved
 * skill + run options to the `SendInput` the runner executes. The framework
 * ships a default (system-role skill message + user-role args message); this
 * seam is the truth — an adopter override fully owns composition.
 */
export type SkillRunCompose = (skill: Skill, opts: SkillRunOptions) => SendInput;

export interface SkillsHandle {
  get(name: string): Skill | undefined;
  has(name: string): boolean;
  list(): readonly Skill[];
  search(input: SkillsSearchInput): readonly Skill[];
  register(input: SkillsRegisterInput): Promise<Skill>;
  update(input: SkillsUpdateInput): Promise<Skill>;
  remove(input: SkillsRemoveInput): Promise<void>;
  subscribe(name: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;

  /**
   * Re-run configured loaders, diff against current state, apply adds
   * + updates (and removes when `pruneMissing: true`). Use to refresh
   * from disk / URL after startup.
   */
  reload(opts?: { pruneMissing?: boolean }): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }>;

  /**
   * Lookup-on-miss read: returns the registered skill if present;
   * otherwise asks each configured loader. `null` if no source has
   * the name.
   */
  resolve(name: string): Promise<Skill | null>;

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `SkillNotFound`-tagged error when no source has the name. Use
   * when missing is a programming error (must-exist contract), not a
   * domain case.
   */
  require(name: string): Promise<Skill>;

  /**
   * Run a skill (three-audiences-plan §C). Sugar composing existing
   * primitives: `require(name)` → compose a `SendInput` (default: system-role
   * skill content + user-role serialized args) → `session.send` → project the
   * skill run IS a send — one grammar. The skill is guidance; the MODEL
   * executes. With `opts.output`, the run rides the structured-output path and
   * returns typed, validated `data`.
   *
   * Inline only in C-core — `opts.isolate: true` rejects with
   * `SkillIsolationUnavailable` (the fork enabler is C2). A missing skill
   * propagates `SkillNotFound` (via `require`). A run with `output` that joins
   * an in-flight execution propagates `SteerCannotCarryStructuredOutput`.
   * Called on a harness with no bound runner (constructed outside a session):
   * `SkillRunnerUnbound`.
   *
   * The run's messages persist to the timeline as ordinary history (the
   * skill's system message + the args, the assistant turn, any tool calls) —
   * inline runs are conversation work by design.
   */
  run<T = unknown>(name: string, opts?: SkillRunOptions<T>): Promise<SessionExecutionHandle<T>>;
}
