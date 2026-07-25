/**
 * `Elicit` — adopter-facing sugar surface for prompting end-users.
 *
 * Tool handlers, agent code, and any other place that needs to ask the
 * user a single typed question call into this API. Concrete instances
 * are created by per-environment factories (the MCP server harness
 * builds one routed through `sdkServer.request("elicitation/create")`;
 * future in-process tool handlers will get one routed through
 * `ElicitationHarness.elicit`).
 *
 * The sugar wraps the underlying `ElicitationRequest` protocol — it
 * produces flat-schema requests for the most common types and
 * normalises the three-action response (`accept`/`decline`/`cancel`)
 * into either a direct value (the throwing variants below) or an
 * {@link ElicitOutcome} discriminated union (the `try*` variants live
 * with the impl, not the spec).
 *
 * Convention (ADR 42 §"Naming rules"):
 *   - `Elicit` is the noun; no "Harness" or "API" suffix in the
 *     adopter-facing alias.
 *   - Each factory exports a value type alongside the interface (e.g.
 *     `McpElicit extends Elicit` for the MCP server flavor).
 *
 * @see ./elicitation-harness.ts — the substrate-level protocol the
 *     sugar wraps.
 */

import type { ElicitationRequest, ElicitationResult } from "./elicitation-harness.js";

// ============================================================================
// The single elicit call the sugar wraps — transport-agnostic
// ============================================================================

/**
 * The one form/url elicit round-trip the {@link Elicit} sugar composes
 * over — transport-agnostic. Every {@link Elicit} method funnels through
 * a single `ElicitFn`; where that call *goes* is the transport's concern:
 *
 *   - **Direct** (`buildSessionElicit`): straight to a live
 *     `ElicitationHarness.elicit` on an in-process tick.
 *   - **Escalated** (ADR 69, tasks): wrapped in `awaitingInput` +
 *     `inbox.ask` up the ownership chain to the client.
 *
 * Because the sugar takes the raw `ElicitFn`, the tasks package can build
 * an escalation-backed `Elicit` WITHOUT depending on `@agentick/elicitation`
 * — the factory (`buildElicitSugar`) is injected. The `unknown` value on
 * the result is intentional: the sugar re-narrows per call via the schema
 * it constructs, so the underlying fn is value-agnostic.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */
export type ElicitFn = (
  request: ElicitationRequest,
  opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
) => Promise<ElicitationResult<unknown>>;

// ============================================================================
// Outcome union — used by `try*` variants (impl-side, not spec — listed here
// so the contract type lives next to the sugar interface)
// ============================================================================

/**
 * Discriminated outcome for `try*` sugar variants. The throwing
 * variants in {@link Elicit} surface `decline`/`cancel` as thrown
 * `ElicitationDeclined` / `ElicitationCancelled` errors (see the
 * impl package). `try*` variants return this union instead.
 */
export type ElicitOutcome<T> =
  | { readonly status: "accept"; readonly value: T }
  | { readonly status: "decline"; readonly reason?: string }
  | { readonly status: "cancel"; readonly reason?: string };

/**
 * Outcome of a URL-mode elicitation. URL mode never carries a value
 * — the user consented (or didn't) to navigate to the URL; whatever
 * happens out-of-band arrives via a separate notification path (e.g.
 * OAuth flow's redirect callback).
 */
export type UrlElicitOutcome =
  | { readonly status: "accept" }
  | { readonly status: "decline"; readonly reason?: string }
  | { readonly status: "cancel"; readonly reason?: string };

/**
 * Single URL specification used by {@link Elicit.url} and
 * {@link Elicit.requireUrls}.
 */
export interface UrlElicitSpec {
  readonly message: string;
  readonly url: string;
  readonly timeoutMs?: ElicitTimeoutOption;
}

// ============================================================================
// Common option types
// ============================================================================

/**
 * Per-call timeout option. `number` is milliseconds; `"never"` disables
 * the auto-cancel timeout. When omitted the factory applies a sensible
 * default (5 minutes for form-mode is the v1 convention).
 */
export type ElicitTimeoutOption = number | "never";

// ============================================================================
// The sugar interface
// ============================================================================

/**
 * Tool-handler-facing sugar for prompting end-users. Methods THROW on
 * `decline` / `cancel` (with `ElicitationDeclined` / `ElicitationCancelled`
 * — defined in the impl package, not spec). Use the `try*` variants
 * (impl-side) when you want to handle those outcomes without exception
 * flow.
 *
 * Every method maps to a single form-mode `elicitation/create` request
 * with a flat schema describing the expected reply shape. The factory
 * routes the request through whatever transport applies (SDK
 * `sdkServer.request` for MCP server; local `ElicitationHarness.elicit`
 * for in-process flows).
 */
export interface Elicit {
  /** Free-text input. Throws on decline/cancel. */
  text(
    message: string,
    opts?: {
      readonly default?: string;
      readonly pattern?: string;
      readonly format?: "email" | "uri" | "date" | "date-time";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<string>;

  /** Pick one option from a fixed enum. Returns the selected value. */
  select<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: {
      readonly default?: T[number];
      readonly labels?: Partial<Record<T[number], string>>;
      readonly timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<T[number]>;

  /** Pick zero-or-more options from a fixed enum. */
  multiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: {
      readonly default?: ReadonlyArray<T[number]>;
      readonly min?: number;
      readonly max?: number;
      readonly labels?: Partial<Record<T[number], string>>;
      readonly timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<Array<T[number]>>;

  /** Yes/no confirmation. */
  confirm(
    message: string,
    opts?: { readonly default?: boolean; readonly timeoutMs?: ElicitTimeoutOption },
  ): Promise<boolean>;

  /** Numeric input with optional bounds + integer constraint. */
  number(
    message: string,
    opts?: {
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
      readonly default?: number;
      readonly timeoutMs?: ElicitTimeoutOption;
    },
  ): Promise<number>;

  /** Boolean toggle (semantically distinct from {@link confirm} in some UIs). */
  boolean(
    message: string,
    opts?: { readonly default?: boolean; readonly timeoutMs?: ElicitTimeoutOption },
  ): Promise<boolean>;

  // ── URL mode — out-of-band consent ─────────────────────────────────

  /**
   * Ask the user to navigate to a URL out-of-band (OAuth, payment,
   * credential entry). `accept` means the user consented to navigate;
   * the actual flow completion arrives via a separate notification
   * (the OAuth callback, etc.) layered on top of this consent signal.
   *
   * Throws `ElicitationNotSupported` if the connected client did not
   * advertise the `elicitation.url` sub-capability. Throws
   * `ElicitationDeclined` / `ElicitationCancelled` on the respective
   * outcomes (use {@link tryUrl} to handle without exceptions).
   */
  url(spec: UrlElicitSpec): Promise<void>;

  /**
   * Throw a {@link UrlElicitationRequired} (-32042 JSON-RPC error)
   * carrying one or more URL-mode elicitations the client should walk
   * before retrying the originating tool call. The canonical pattern
   * for OAuth-style deferred auth: the tool handler detects "I need
   * the user to complete X before I can proceed," packages the URLs,
   * and never returns. The client's tool wrapper recognizes the
   * -32042 code, walks the URLs, then retries.
   */
  requireUrls(
    elicitations: ReadonlyArray<{ readonly message: string; readonly url: string }>,
  ): never;

  // ── try* variants — discriminated outcomes instead of throwing ─────

  tryText(message: string, opts?: Parameters<Elicit["text"]>[1]): Promise<ElicitOutcome<string>>;
  trySelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<Elicit["select"]>[2],
  ): Promise<ElicitOutcome<T[number]>>;
  tryMultiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<Elicit["multiSelect"]>[2],
  ): Promise<ElicitOutcome<Array<T[number]>>>;
  tryConfirm(
    message: string,
    opts?: Parameters<Elicit["confirm"]>[1],
  ): Promise<ElicitOutcome<boolean>>;
  tryNumber(
    message: string,
    opts?: Parameters<Elicit["number"]>[1],
  ): Promise<ElicitOutcome<number>>;
  tryBoolean(
    message: string,
    opts?: Parameters<Elicit["boolean"]>[1],
  ): Promise<ElicitOutcome<boolean>>;
  tryUrl(spec: UrlElicitSpec): Promise<UrlElicitOutcome>;

  // ── Capability probes ──────────────────────────────────────────────

  /**
   * Capability probe — true when the connected client advertised the
   * `elicitation.form` sub-capability (or the legacy empty
   * `elicitation: {}` shape). Factories that route over a transport
   * lacking elicitation support return `false` here AND throw a
   * helpful error from each method when called regardless.
   */
  canDoForm(): boolean;

  /**
   * Capability probe for URL mode (`elicitation.url` sub-capability).
   * Legacy empty `elicitation: {}` advertises form-only, so this
   * returns `false` for those clients.
   */
  canDoUrl(): boolean;
}
