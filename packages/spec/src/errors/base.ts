/**
 * `AgentickError` — abstract root of the v2 typed-error hierarchy.
 *
 * Every typed error v2 raises subclasses this. Two-level hierarchy:
 *
 *   `AgentickError` (this file, abstract)
 *     ↓
 *   per-domain abstract intermediates (`AppError`, `SessionError`,
 *   `McpServerError`, …) — each lives next to its concrete classes in
 *   the relevant `errors/<domain>.ts` file.
 *     ↓
 *   concrete classes carry domain fields as constructor args.
 *
 * Adopters typecheck against the base for cross-cutting code:
 *   ```ts
 *   try { … } catch (err) { if (err instanceof AgentickError) … }
 *   ```
 *
 * Or against a specific intermediate / concrete for narrower handling:
 *   ```ts
 *   if (err instanceof McpServerError) … // any MCP server error
 *   if (err instanceof McpServerAuthRejected) … // exactly this tag
 *   ```
 *
 * Or against the discriminator for Effect's pattern matching:
 *   ```ts
 *   pipe(eff, Effect.catchTag("McpServerAuthRejected", h))
 *   switch (err._tag) { case "McpServerAuthRejected": … }
 *   ```
 *
 * See ADR 41 for the full design.
 */

/**
 * The discriminator literal that survives on every concrete subclass.
 * Concrete classes declare `readonly _tag = "MyTagName" as const`.
 */
export type AgentickErrorTag = string;

/**
 * Common construction options. Concrete classes typically widen this
 * with their domain fields.
 */
export interface AgentickErrorOptions {
  /**
   * Inner cause — flowed through to `Error.cause` (ES2022). Use
   * `errorReason()` from `@agentick/utils` to normalize foreign
   * thrown values before passing them here.
   */
  readonly cause?: unknown;
}

/**
 * Root of the v2 typed-error hierarchy. `extends Error` so it
 * participates in standard ES exception semantics (catchable as `Error`,
 * carries `stack`, `cause`, `message`). Adds the `_tag` discriminator
 * concrete subclasses must declare.
 *
 * Cannot be constructed directly — use a concrete subclass.
 */
export abstract class AgentickError extends Error {
  /**
   * String discriminator. Each concrete subclass declares its own
   * literal via `readonly _tag = "MyTag" as const`.
   *
   * Effect uses this for `Effect.catchTag`; users use it for exhaustive
   * `switch` on the discriminated union channel type.
   */
  abstract readonly _tag: AgentickErrorTag;

  /**
   * Optional stable framework-wide error code for telemetry /
   * customer-facing surfaces. Empty unless a concrete class explicitly
   * overrides. Most errors leave this unset — `_tag` is enough.
   */
  readonly code?: string;

  protected constructor(message: string, options?: AgentickErrorOptions) {
    super(message, options);
    // Resolves to the concrete subclass name when invoked via
    // `new SubclassName(...)`. Avoids per-subclass boilerplate.
    this.name = this.constructor.name;
  }

  /**
   * JSON projection — keyed by `_tag`, carries `message` and all own
   * enumerable fields except `name` / `stack`. The codec in
   * `./codec.ts` uses this for serialization.
   *
   * Concrete classes that need to redact a field (e.g. a `cause` that
   * could carry secrets) override and return a filtered object.
   */
  toJSON(): SerializedAgentickError {
    const result: Record<string, unknown> = {
      _tag: this._tag,
      message: this.message,
    };
    for (const [k, v] of Object.entries(this)) {
      // Skip Error-inherited slots already accounted for or not safe to
      // ship over a wire.
      if (k === "name" || k === "message" || k === "stack" || k === "_tag") continue;
      result[k] = v;
    }
    return result as SerializedAgentickError;
  }
}

/**
 * On-the-wire shape of a serialized `AgentickError`. The codec
 * round-trip preserves `_tag` (discriminator), `message`, and all
 * own enumerable fields the concrete class exposes.
 */
export interface SerializedAgentickError {
  readonly _tag: AgentickErrorTag;
  readonly message: string;
  readonly [field: string]: unknown;
}

/**
 * Type guard — narrows `unknown` to `AgentickError`. Equivalent to
 * `value instanceof AgentickError`; the named predicate keeps call
 * sites readable when guard composition matters.
 */
export function isAgentickError(value: unknown): value is AgentickError {
  return value instanceof AgentickError;
}
