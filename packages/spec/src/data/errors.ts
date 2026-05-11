/**
 * Substrate-level error taxonomies.
 *
 * Typed errors for the three substrate components — journal, bus, inbox.
 * Implementations throw or reject with these tagged shapes; consumers
 * can pattern-match.
 *
 * Distinct from per-harness error types (CompileError, ProviderError,
 * etc.), which live in their respective harness contract files.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md
 */

/**
 * `OperationJournal` failure modes.
 */
export type JournalError =
  | { readonly _tag: "WriteFailed"; readonly cause: unknown }
  | { readonly _tag: "ReadFailed"; readonly cause: unknown }
  | {
      readonly _tag: "OffsetOutOfRange";
      readonly requested: number;
      readonly oldest: number;
    };

/**
 * `MessageInbox` routing-side failure modes (distinct from handler-side
 * failures, which use `MessageHandlerError`).
 */
export type InboxError =
  | { readonly _tag: "AddressNotFound"; readonly address: string }
  | { readonly _tag: "RoutingFailed"; readonly cause: unknown }
  | { readonly _tag: "InboxClosed" }
  | { readonly _tag: "AskTimeout"; readonly timeoutMs: number };

/**
 * Handler-side failure for inbox messages. Distinguished from
 * `InboxError` (routing-side) because they have different recovery
 * profiles: routing errors are usually transient or configuration
 * issues; handler errors are application logic.
 */
export type MessageHandlerError =
  | { readonly _tag: "HandlerError"; readonly cause: unknown }
  | { readonly _tag: "InvalidPayload"; readonly reason: string };
