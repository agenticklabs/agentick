/**
 * `CompletionsHarnessProtocol` — argument completion as a first-class seam.
 *
 * A user typing into a command form needs the machine to finish their sentence:
 * `/tm_change_order_actual_cost` asks for a `job`, and the honest answer to
 * "which job?" is a lookup against the tenant's data — filtered by what was
 * typed, conditioned on the sibling arguments already filled, executed with the
 * caller's identity. MCP names this `completion/complete`; agentick names it a
 * registry of `name → resolver` plus one `resolve` door.
 *
 * ## Deliberately NOT a tool
 *
 * A completion fires per keystroke and is an ephemeral QUERY, not a thing that
 * happened. Routing it through tool dispatch would flood the journal, wrap a
 * plain string list in the ADR 70 result envelope, and leak completion plumbing
 * into every tools-enumeration surface. Hence its own seam — and hence
 * `resolve` is NOT a declared command (no operation is minted per keystroke).
 *
 * ## What crosses the firewall
 *
 * A {@link CompletionResolver} is a FUNCTION, so it never crosses the spec
 * firewall: a declaration references a resolver by NAME (the `handlerRef`
 * pattern) and the registry holds the function. Spec owns the currency
 * ({@link CompletionResult}), the ctx shape ({@link CompletionCtx}), and the
 * protocol; `@agentick/completions` owns the registry and the sugar builders.
 *
 * @see docs/proposals/v2/completions.md
 * @see docs/proposals/v2/blueprint/91-ctx-spine.md §2 — the ctx spine this seam rides
 */

import type { Effect } from "effect";
import type { CompletionsErrorChannel } from "../errors/harnesses.js";
import type { OperationCtx } from "../data/runtime-context.js";
import type { Unsubscribe } from "./inbox.js";
import type { HarnessFx } from "./middleware.js";

// ============================================================================
// Result currency
// ============================================================================

/**
 * What a completion answers with. Identical to MCP's `completion/complete`
 * result shape, so the MCP projection is a copy rather than a translation.
 *
 * **No cap semantics here.** MCP caps a `completion/complete` response at 100
 * values; that is MCP's constraint, applied at MCP's projection. A resolver
 * returns everything it found, and each wire trims to its own advertised limit
 * (setting `hasMore` when it does).
 */
export interface CompletionResult {
  readonly values: readonly string[];
  /** Full match count, when the source knows it. */
  readonly total?: number;
  /** `values` is a prefix of the real answer. */
  readonly hasMore?: boolean;
}

/**
 * What a resolver may RETURN — the full {@link CompletionResult} or a bare
 * `string[]` (sugar for `{ values }`). `normalizeCompletionResult` in
 * `@agentick/completions` folds the sugar; the harness's `resolve` always
 * answers with the full shape.
 */
export type CompletionValues = readonly string[] | CompletionResult;

// ============================================================================
// The resolver seam
// ============================================================================

/**
 * The ctx a completion resolver receives: the ADR 91 spine
 * ({@link OperationCtx} — the trunk's `sessionId` / `opId` / identity plus the
 * `log` / `trace` / `metrics` / `run` facets) with two boundary facets composed
 * in. Same "`OperationCtx` & boundary facets" pattern as `ResourceResolver` and
 * `PromptDeclaration.render`.
 *
 * It is deliberately NOT a `ToolHandlerCtx`: a keystroke query has no
 * `toolCallId`, no `task` mode, and no `transport` discriminator, so a
 * tool-handler ctx would have to be fabricated — which the `Derived` brand makes
 * a compile error. The one dispatch extra completion genuinely shares is the
 * `AbortSignal`, carried here as a facet.
 */
export type CompletionCtx = OperationCtx & {
  /**
   * Sibling-argument values the user has already entered — MCP's
   * `context.arguments`. Empty object when the caller supplies none. This is
   * what makes conditional completion possible: the phases of *that* job.
   */
  readonly resolvedArguments: Readonly<Record<string, string>>;
  /**
   * Latest-wins cancellation. A composer issues one request per keystroke and
   * aborts the previous; a resolver doing real I/O should forward this.
   * `undefined` when the caller offers no cancellation.
   */
  readonly signal?: AbortSignal;
};

/**
 * A named completion source: given the partial value typed so far and a
 * {@link CompletionCtx}, produce candidates. Sync or async; bare array or full
 * result. Authored inline or built with the `complete*` sugar family in
 * `@agentick/completions`.
 */
export type CompletionResolver = (
  value: string,
  ctx: CompletionCtx,
) => CompletionValues | Promise<CompletionValues>;

// ============================================================================
// Input shapes
// ============================================================================

/** Arguments to {@link CompletionsHarnessProtocol.resolve}. */
export interface CompletionsResolveInput {
  /** The partial value typed so far. Empty string asks for the unfiltered set. */
  readonly value: string;
  /** Sibling arguments already filled. Defaults to `{}` on the resolver's ctx. */
  readonly resolvedArguments?: Readonly<Record<string, string>>;
  /** Latest-wins cancellation, forwarded to the resolver's ctx. */
  readonly signal?: AbortSignal;
}

// ============================================================================
// Errors
// ============================================================================

/** Migrated to the class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  CompletionNotFound,
  CompletionResolveFailed,
  CompletionsError,
  type CompletionsErrorChannel,
} from "../errors/harnesses.js";

// ============================================================================
// Protocol
// ============================================================================

/**
 * The completions harness's **canonical** resolve surface: the composable Effect
 * twin of the {@link CompletionsHarnessProtocol.resolve} door. Returns the
 * resolve Effect un-run, so an in-fiber caller composes it with `yield*` and
 * stays in ONE fiber tree; `completions.resolve(...)` is the derived Promise
 * facade.
 *
 * ## Why this is on the PROTOCOL, not just the concrete class
 *
 * Same rule as {@link import("./prompts-harness.js").PromptsFx} and
 * {@link import("./resources-harness.js").ResourcesFx}: the MCP server's
 * completions projection holds `Completions` (the protocol) and resolves from
 * INSIDE the `mcp:command:complete` crossing operation. Through the Promise
 * facade the resolver's ctx is minted from the harness's CONSTRUCTION-bound
 * scope, so it carries the owning session's identity and knows nothing of the
 * connection that asked (ADR 92 §Slice A, the residual ADR 91 stop-rule #2).
 * Composed on the crossing's captured runtime, the trunk connection → crossing →
 * `resolver(value, ctx)` stays intact, and the resolver reads the CALLER's
 * `ctx.mcp.user` exactly as a `PromptDeclaration.render` does.
 *
 * Neither face mints a journaled operation — `resolve` is deliberately not a
 * declared command (see the protocol doc-block), so this is the one `.fx`
 * surface in the tree that is NOT sugar over `commandEffect`. What it buys is
 * the FIBER, not the envelope.
 */
export interface CompletionsFx extends HarnessFx {
  /**
   * Run a named resolver on the CALLING fiber — the Effect twin of
   * {@link CompletionsHarnessProtocol.resolve}. Mints the resolver's
   * {@link CompletionCtx} from the ambient operation trunk (plus the caller's
   * `resolvedArguments` / `signal`) rather than the harness's own scope.
   */
  resolve(
    name: string,
    input: CompletionsResolveInput,
  ): Effect.Effect<CompletionResult, CompletionsErrorChannel, never>;
}

/**
 * The completions harness protocol — a registry and a resolve door, nothing
 * more. No snapshot (a resolver is a function and does not serialize; a session
 * re-registers from its tree / definition on restore), no pagination (names are
 * few and the values a resolver returns are already the paged thing), no
 * per-name subscribe (a registry-topology notifier is what a composer needs to
 * know its completable slots changed).
 *
 * Implementation: `CompletionsHarness` in `@agentick/completions`.
 */
export interface CompletionsHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  /**
   * The Effect-canonical resolve surface — the twin an in-fiber caller composes
   * with `yield*`. On the PROTOCOL so a protocol-typed ref (the MCP server's
   * completions projection) can resolve without severing the fiber at the
   * Promise facade. See {@link CompletionsFx}.
   */
  readonly fx: CompletionsFx;
  close(): Promise<void>;

  // ─── Sync surface ─────────────────────────────────────────────

  /** True iff a resolver is registered under this name. */
  has(name: string): boolean;
  /** Every registered name, sorted. The completable set a composer enumerates. */
  list(): readonly string[];
  /** Notify when the registered set changes (register / unregister). */
  subscribeAll(listener: () => void): Unsubscribe;

  // ─── Registration ─────────────────────────────────────────────

  /**
   * Bind a resolver to a name. A plain synchronous registry insert returning its
   * own removal — the resolver is a REQUIRED function argument, so this is an
   * in-process method and never a wire-addressable command (ADR 51 §1.2).
   *
   * UPSERT, not insert: re-registering a name replaces the resolver. The
   * declarative path auto-registers inline resolvers under derived names on
   * every render pass, and a throw there would fail the second render of an
   * unchanged tree. The returned `Unsubscribe` removes the binding only while it
   * is still the CURRENT one, so a stale handle cannot delete its replacement.
   */
  register(name: string, resolver: CompletionResolver): Unsubscribe;

  // ─── The door ─────────────────────────────────────────────────

  /**
   * Run a named resolver. Mints the resolver's {@link CompletionCtx} from this
   * harness's owning scope + the caller's `resolvedArguments` / `signal`.
   *
   * @throws {CompletionNotFound} no resolver is registered under `name`.
   * @throws {CompletionResolveFailed} the resolver threw or rejected.
   */
  resolve(name: string, input: CompletionsResolveInput): Promise<CompletionResult>;
}

/**
 * Adopter-facing alias for {@link CompletionsHarnessProtocol}. Use this in
 * surface APIs so adopters never have to type "Harness" in their code.
 */
export type Completions = CompletionsHarnessProtocol;

/**
 * Structural type guard for a live `Completions` instance. Discriminates the
 * ADR 42 dichotomy — a `defineCompletions` MAP (whose values are resolvers)
 * versus a live harness — by the protocol method surface; mirrors
 * {@link isPromptsInstance}. Test for the instance form first, then treat the
 * value as the definition map.
 */
export function isCompletionsInstance(v: unknown): v is Completions {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.register === "function" &&
    typeof obj.resolve === "function" &&
    typeof obj.has === "function" &&
    typeof obj.list === "function" &&
    typeof obj.subscribeAll === "function"
  );
}
