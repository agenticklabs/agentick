/**
 * Substrate-level error classes — journal, inbox, message-handler,
 * lifecycle-handler failures.
 *
 * Migrated from POJO `_tag` unions to the `AgentickError` class
 * hierarchy per ADR 41. Each domain has an abstract intermediate
 * (`JournalError`, `InboxError`, `MessageHandlerError`) plus concrete
 * subclasses; single-tag `LifecycleHandlerError` is concrete directly
 * under `AgentickError`.
 *
 * The wire `_tag` values are preserved exactly — same discriminators
 * Effect's `catchTag` and the codec's registry read. No protocol-level
 * shape change.
 */

import { AgentickError } from "./base.js";
import { registerAgentickError } from "./registry.js";

// ============================================================================
// JournalError — `OperationJournal` failure modes
// ============================================================================

/**
 * Abstract base for journal failures. `err instanceof JournalError`
 * matches any of the three concrete subclasses below.
 */
export abstract class JournalError extends AgentickError {}

export class WriteFailed extends JournalError {
  readonly _tag = "WriteFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`journal write failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("WriteFailed", WriteFailed);

export class ReadFailed extends JournalError {
  readonly _tag = "ReadFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`journal read failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("ReadFailed", ReadFailed);

export class OffsetOutOfRange extends JournalError {
  readonly _tag = "OffsetOutOfRange" as const;
  readonly requested: number;
  readonly oldest: number;
  constructor(args: {
    readonly requested: number;
    readonly oldest: number;
    readonly cause?: unknown;
  }) {
    super(`journal offset out of range: requested=${args.requested}, oldest=${args.oldest}`, {
      cause: args.cause,
    });
    this.requested = args.requested;
    this.oldest = args.oldest;
  }
}
registerAgentickError("OffsetOutOfRange", OffsetOutOfRange);

/**
 * Exhaustive discriminated union over the journal failure variants —
 * use this where pattern-matching by `_tag` matters (e.g. `switch`).
 * For runtime `instanceof` group checks use the abstract class.
 */
export type JournalErrorChannel = WriteFailed | ReadFailed | OffsetOutOfRange;

// ============================================================================
// InboxError — `MessageInbox` routing-side failures
// ============================================================================

/**
 * Abstract base for routing-side inbox failures. Distinct from
 * {@link MessageHandlerError} (handler-side): routing failures are
 * usually transient or configuration issues; handler failures are
 * application logic.
 */
export abstract class InboxError extends AgentickError {}

export class AddressNotFound extends InboxError {
  readonly _tag = "AddressNotFound" as const;
  readonly address: string;
  constructor(args: { readonly address: string; readonly cause?: unknown }) {
    super(`inbox address not found: ${args.address}`, { cause: args.cause });
    this.address = args.address;
  }
}
registerAgentickError("AddressNotFound", AddressNotFound);

export class RoutingFailed extends InboxError {
  readonly _tag = "RoutingFailed" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`inbox routing failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("RoutingFailed", RoutingFailed);

export class InboxClosed extends InboxError {
  readonly _tag = "InboxClosed" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(`inbox closed`, { cause: args?.cause });
  }
}
registerAgentickError("InboxClosed", InboxClosed);

export class AskTimeout extends InboxError {
  readonly _tag = "AskTimeout" as const;
  readonly timeoutMs: number;
  constructor(args: { readonly timeoutMs: number; readonly cause?: unknown }) {
    super(`inbox ask timed out after ${args.timeoutMs}ms`, { cause: args.cause });
    this.timeoutMs = args.timeoutMs;
  }
}
registerAgentickError("AskTimeout", AskTimeout);

export type InboxErrorChannel = AddressNotFound | RoutingFailed | InboxClosed | AskTimeout;

// ============================================================================
// MessageHandlerError — inbox handler-side failures
// ============================================================================

/**
 * Abstract base for handler-side inbox failures. Distinct from
 * {@link InboxError} (routing-side).
 */
export abstract class MessageHandlerError extends AgentickError {}

export class HandlerError extends MessageHandlerError {
  readonly _tag = "HandlerError" as const;
  override readonly cause: unknown;
  constructor(args: { readonly cause: unknown }) {
    super(`inbox message handler failed: ${String(args.cause)}`, { cause: args.cause });
    this.cause = args.cause;
  }
}
registerAgentickError("HandlerError", HandlerError);

export class InvalidPayload extends MessageHandlerError {
  readonly _tag = "InvalidPayload" as const;
  readonly reason: string;
  constructor(args: { readonly reason: string; readonly cause?: unknown }) {
    super(`invalid payload: ${args.reason}`, { cause: args.cause });
    this.reason = args.reason;
  }
}
registerAgentickError("InvalidPayload", InvalidPayload);

export type MessageHandlerErrorChannel = HandlerError | InvalidPayload;

// ============================================================================
// LifecycleHandlerError — single-tag substrate-lifecycle failure
// ============================================================================

/**
 * Lifecycle-handler failure raised by `BaseHarness.runOperation` when
 * a `before` (or `after`) handler's Effect fails. Single-tag — no
 * abstract intermediate.
 */
export class LifecycleHandlerError extends AgentickError {
  readonly _tag = "LifecycleHandlerError" as const;
  readonly phase: "before" | "after" | (string & {});
  override readonly cause: unknown;
  constructor(args: {
    readonly phase: "before" | "after" | (string & {});
    readonly cause: unknown;
  }) {
    super(`lifecycle ${args.phase}-handler failed`, { cause: args.cause });
    this.phase = args.phase;
    this.cause = args.cause;
  }
}
registerAgentickError("LifecycleHandlerError", LifecycleHandlerError);
