/**
 * Substrate-level error taxonomies.
 *
 * **Migration in progress (ADR 41).** Most substrate errors moved to
 * `../errors/substrate.ts` as `AgentickError` subclasses. This file
 * now hosts only the cross-cutting `SubstrateError` union which mixes
 * spec-side classes with `OperationOutcomeError` (whose class home is
 * `@agentick/runtime-next` — out of scope for this spec module). The
 * union is structural so that union-member references stay valid
 * regardless of where the class is declared.
 *
 * Per-domain error classes (`JournalError`, `InboxError`,
 * `MessageHandlerError`, `LifecycleHandlerError` + their concrete
 * subclasses) re-export from `@agentick/spec-next/errors`.
 *
 * @see docs/proposals/v2/blueprint/41-error-hierarchy.md
 * @see docs/proposals/v2/blueprint/19-foundation.md
 */

import type { CommandOutcome, TerminalEvent } from "./outcomes.js";

// Re-export the substrate error classes from their canonical home so
// existing `import { JournalError, ... } from "../data/errors.js"`
// import paths keep working through the migration. New code SHOULD
// import directly from `@agentick/spec-next/errors`.
export {
  AddressNotFound,
  AskTimeout,
  HandlerError,
  InboxClosed,
  InboxError,
  type InboxErrorChannel,
  InvalidPayload,
  JournalError,
  type JournalErrorChannel,
  LifecycleHandlerError,
  MessageHandlerError,
  type MessageHandlerErrorChannel,
  OffsetOutOfRange,
  ReadFailed,
  RoutingFailed,
  WriteFailed,
} from "../errors/substrate.js";

import type { JournalError, LifecycleHandlerError } from "../errors/substrate.js";

/**
 * Tagged-union envelope for every failure mode the substrate itself
 * can surface from `BaseHarness.runOperation`. Concrete harnesses
 * union this with their own body's `E` channel — i.e., `runOperation`
 * returns `Effect<R, E | SubstrateError, never>`.
 *
 * Members:
 *   - `OperationOutcomeError`  — non-success terminals (canceled, vetoed,
 *                                 deferred, replayed `failed`). Class
 *                                 lives in `@agentick/runtime-next`;
 *                                 referenced here by its structural
 *                                 shape so spec stays runtime-free.
 *   - `JournalError`           — abstract class in `../errors/substrate.ts`
 *                                 with three concrete variants.
 *   - `LifecycleHandlerError`  — concrete class in `../errors/substrate.ts`.
 *
 * All three members participate in `Effect.catchTag` via their `_tag`
 * discriminator AND in `instanceof AgentickError` via the class chain.
 */
export type SubstrateError =
  | {
      readonly _tag: "OperationOutcomeError";
      readonly outcome: CommandOutcome;
      readonly terminal: TerminalEvent;
    }
  | JournalError
  | LifecycleHandlerError;
