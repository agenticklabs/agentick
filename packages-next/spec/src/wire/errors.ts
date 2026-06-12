/**
 * Wire error codes.
 *
 * Three ranges:
 *
 *   - **JSON-RPC 2.0 reserved** (-32700 to -32600): parse / envelope errors
 *     defined by the spec.
 *   - **LSP convention** (-32800, -32801): cancellation / content modified.
 *     Borrowed because the LSP / MCP ecosystem treats them as standard.
 *   - **Agentick application codes** (-32000 to -32050): our domain-specific
 *     errors. Codes -32099 to -32051 reserved for adopter overrides.
 *
 * Codes outside these ranges are not used. Adopters define their own
 * application error codes by extending `ErrorCode` via declaration merging.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Error code table"
 */

/**
 * Canonical error code namespace. Use the named constant — never a magic
 * number — so consumers can switch over `code` against the symbolic name.
 */
export const ErrorCode = {
  // ── JSON-RPC 2.0 standard ──────────────────────────────────────────────────
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // ── LSP convention ─────────────────────────────────────────────────────────
  RequestCancelled: -32800,
  ContentModified: -32801,

  // ── Agentick application codes ─────────────────────────────────────────────
  /** Unspecified application error. Use only when nothing more specific fits. */
  AppError: -32000,

  AuthRequired: -32001,
  AuthFailed: -32002,
  Forbidden: -32003,

  SessionNotFound: -32010,
  AppNotFound: -32011,
  SubscriptionNotFound: -32012,

  CursorEvicted: -32020,
  Conflict: -32021,

  ChallengeRequired: -32030,
  TokenExpired: -32031,

  RateLimited: -32040,
  Backpressure: -32050,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

import type { Cursor } from "../protocol/event-log.js";

/**
 * Structured error `data` shapes for specific error codes. Carrying typed
 * data lets clients match on the code and read the data with type safety.
 *
 * Extend via declaration merging when an adopter introduces a new code:
 *
 * ```ts
 * declare module "@agentick/spec-next" {
 *   interface ErrorData {
 *     [-32100]: { customField: string };
 *   }
 * }
 * ```
 */
export interface ErrorData {
  [ErrorCode.SessionNotFound]: { readonly appId: string; readonly sessionId: string };
  [ErrorCode.AppNotFound]: { readonly appId: string };
  [ErrorCode.SubscriptionNotFound]: { readonly subscriptionId: string };
  [ErrorCode.CursorEvicted]: {
    readonly requested: Cursor;
    readonly oldestAvailable: Cursor;
  };
  [ErrorCode.ChallengeRequired]: {
    readonly challengeId: string;
    readonly method: string;
    readonly acr?: string;
  };
  [ErrorCode.RateLimited]: {
    readonly retryAfterMs: number;
    readonly limit?: number;
  };
}
