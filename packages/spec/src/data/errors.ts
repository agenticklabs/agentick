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

/**
 * Lifecycle-handler failure raised by `BaseHarness.runOperation` when a
 * `before`-phase handler's Effect fails. Distinct from `MessageHandlerError`
 * (inbox) and from the body's own typed error channel. Carried in the
 * substrate error channel so callers can pattern-match by `_tag`.
 */
export type LifecycleHandlerError = {
  readonly _tag: "LifecycleHandlerError";
  readonly phase: "before" | "after" | (string & {});
  readonly cause: unknown;
};

/**
 * Tagged-union envelope for every failure mode the substrate itself can
 * surface from `BaseHarness.runOperation`. Concrete harnesses union this
 * with their own body's `E` channel — i.e., `runOperation` returns
 * `Effect<R, E | SubstrateError, never>`.
 *
 * Members:
 *   - `OperationOutcomeError`  — non-success terminals (canceled, vetoed,
 *                                 deferred, replayed `failed`)
 *   - `JournalError`           — write/read failures bubbled from the journal
 *   - `LifecycleHandlerError`  — a before-handler's Effect failed
 *
 * `OperationOutcomeError` is exposed as a class (instanceof-friendly) but
 * also carries `_tag` so it pattern-matches identically.
 */
export type SubstrateError =
  | { readonly _tag: "OperationOutcomeError"; readonly outcome: import("./outcomes.js").CommandOutcome; readonly terminal: import("./outcomes.js").TerminalEvent }
  | JournalError
  | LifecycleHandlerError;
