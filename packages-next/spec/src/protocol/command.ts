/**
 * Command declarations — the harness invocation model (ADR 51).
 *
 * A **command** is a verb + serializable payload, declared once on a
 * harness via `BaseHarness.command()`. The declaration's canonical
 * verb string (`"timeline:append"`) is simultaneously:
 *
 *   - the inbox **message type** (command dispatch routes by it)
 *   - the **op-name root** (`timeline:append` → op name
 *     `timeline:command:append`, opId prefix `timeline:append:`)
 *   - the **authz scope label** (identity authz at the wire gate)
 *   - the **policy-rule target** (capability policy)
 *   - the **wire method name** (`timeline/compact`, via `:` → `/`)
 *
 * One string, declared in one place, consumed everywhere. Verbs and
 * serializable data cross boundaries; executable configuration never
 * does (the signal-form rule) — a command with a required function
 * parameter is unaddressable by definition and must not be declared;
 * give it a construction-bound default and declare the data-only
 * signal form instead.
 *
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import type { StandardSchemaV1 } from "../data/standard-schema.js";

/**
 * How far a command's reachability extends (ADR 51 §2.3). Widening
 * levels; curation lives on the declaration because the harness
 * author — not the gateway adopter — knows whether a verb is safe to
 * expose. Which *principal* may invoke an exposed verb is a separate
 * policy act (the Authorizer, ADR 51 §4).
 *
 * - `"internal"`    — in-process only; not inbox-addressable.
 * - `"addressable"` — (default) reachable via inbox/cluster message —
 *                     the trusted domains.
 * - `"wire"`        — additionally projectable to wire clients via the
 *                     dynamic resolver, gated by the Authorizer.
 */
export type CommandExposure = "internal" | "addressable" | "wire";

/**
 * A declared command. Built by `BaseHarness.command()`; enumerable via
 * `commands()` and the per-harness `<surface>:commands` meta-verb.
 */
export interface CommandDescriptor<I = unknown> {
  /** Canonical verb — `"<surface>:<rest>"`, e.g. `"timeline:append"`. */
  readonly name: string;
  /**
   * Standard Schema for the payload. Validated ONCE, at command
   * dispatch on the receiving harness — the wire deliberately does not
   * duplicate validation (one schema, one check, zero drift).
   */
  readonly input?: StandardSchemaV1<I>;
  /** Reachability. Default `"addressable"`. */
  readonly exposure: CommandExposure;
  readonly description?: string;
}

/**
 * Wire-safe summary of a {@link CommandDescriptor} — what the
 * `<surface>:commands` meta-verb and `commands/list` return. The
 * schema itself is not serializable; `hasInput` records its presence.
 */
export interface CommandInfo {
  readonly name: string;
  readonly exposure: CommandExposure;
  readonly hasInput: boolean;
  readonly description?: string;
}
