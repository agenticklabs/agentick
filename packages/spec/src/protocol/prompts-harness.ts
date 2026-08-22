/**
 * `PromptsHarnessProtocol` — durable, parameterized prompt library.
 *
 * A **prompt** is a named, argument-bearing template that, when
 * invoked, renders to a sequence of role-bearing messages. Adopters
 * register prompts with the harness; the agent (or admin tooling)
 * invokes them by name with arguments, and the harness produces the
 * messages — either injected directly into the session timeline
 * (`invoke`) or returned for caller-managed handling (`get`).
 *
 * The design intentionally mirrors MCP's `prompts/*` shape (per
 * [ADR 23 — MCP as harness](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md))
 * so an MCP server harness (#171) can project our prompts onto the
 * wire without translation.
 *
 * Shape 1 harness per [ADR 32](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md):
 * substrate participation, audit envelopes, swappable backend,
 * snapshot/restore.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Prompts
 */

import type { Effect } from "effect";
import type { MessageEntry } from "../data/entries.js";
import type { SubstrateError } from "../data/errors.js";
import type { CompletionResolver, CompletionResult } from "./completions-harness.js";
import type { CompletionsErrorChannel, PromptsErrorChannel } from "../errors/harnesses.js";
import type { Elicit } from "./elicit-api.js";
import type { OperationCtx } from "../data/runtime-context.js";
import type { StandardSchemaV1 } from "../data/standard-schema.js";
import type { Unsubscribe } from "./inbox.js";
import type { HarnessFx } from "./middleware.js";

// ============================================================================
// Argument descriptor
// ============================================================================

/**
 * Declaration for a single prompt argument. The harness validates
 * `args` against these descriptors before invocation; missing
 * required args fail with `PromptArgumentMissing`, schema mismatches
 * fail with `PromptArgumentInvalid`.
 *
 * `schema` is Standard-Schema-compliant (per
 * [Task #118](../../../../docs/proposals/v2/STATUS.md)). When
 * omitted, no shape validation runs — the arg's value passes through
 * to `render(args)` as-is.
 */
export interface PromptArgument {
  /** Argument name. Used as the key in the args object. */
  readonly name: string;
  /** One-line description; shown in command palette / slash list / MCP `prompts/list`. */
  readonly description?: string;
  /** Standard-Schema validator. Omit for no validation. */
  readonly schema?: StandardSchemaV1;
  /** Default `false` — arg is optional. */
  readonly required?: boolean;
  /**
   * How this argument COMPLETES — what a composer offers while the user types.
   * Either form of the ADR 42 dichotomy:
   *
   *   - an INLINE {@link CompletionResolver} — the declarative shorthand, and the
   *     common case. A function, so it follows the `render` precedent exactly: it
   *     lives in the harness's augmentation sidecar and never reaches durability
   *     (the record carries a `completeRef` string instead, see
   *     {@link PromptArgumentRecord}).
   *   - a NAMED REF (`"knowify.jobs"`) into the completions registry — the
   *     reusable form. A string crosses the spec firewall the way `handlerRef`
   *     does; the resolver itself stays registry-resident.
   *
   * **LAW.** The resolver is invoked with the PARTIAL value typed so far and a
   * {@link CompletionResolver}'s {@link import("./completions-harness.js").CompletionCtx},
   * whose `resolvedArguments` are THIS prompt's sibling arguments — the values
   * the user has already filled in on the same form. That is what makes
   * conditional completion possible (the phases of *that* job), and it is why a
   * resolver declared here is not interchangeable with a free-standing query:
   * the sibling scope is the prompt's argument list, nothing wider.
   *
   * @see docs/proposals/v2/completions.md §2.1
   */
  readonly complete?: CompletionResolver | string;
}

/**
 * The **record-safe** slice of a {@link PromptArgument} — what
 * {@link PromptDeclarationRecord} holds and the store persists. It is
 * `PromptArgument` with the author-facing `complete` slot REPLACED by its two
 * serializable projections.
 *
 * The `complete?: never` is deliberate, and is what makes the split load-bearing
 * rather than documentary: a `PromptArgument` carrying a resolver is NOT
 * assignable to this type, so a write site that forgets to normalize fails to
 * compile instead of quietly persisting a closure.
 *
 * **Pre-existing wart, deliberately not fixed here:** `schema` survives the
 * Omit, and a `StandardSchemaV1` carries a `~standard.validate` function — so
 * this record is not *fully* JSON-safe today. Do not read the `complete` split
 * as a claim that it is; the claim is narrower and exact: no COMPLETION resolver
 * reaches durability.
 */
export type PromptArgumentRecord = Omit<PromptArgument, "complete"> & {
  /** Never present on a record. See the type doc — this is the forcing function. */
  readonly complete?: never;
  /**
   * The registry NAME of this argument's resolver: the author's string ref
   * verbatim, or — for an inline resolver — the name the prompts harness derived
   * for it (`prompt:<promptName>:<argName>`, whose `prompt:` prefix is RESERVED
   * for derived refs). The sidecar holds the function; this holds its address.
   */
  readonly completeRef?: string;
  /**
   * Sibling arguments that must be filled before this one is completable, from a
   * `completeDependent({ requires })` resolver's readable metadata. The
   * PROJECTABLE half of that declaration (completions.md §4): a composer reads
   * it to grey out a slot instead of issuing a doomed request per keystroke.
   *
   * Populated at normalization from the INLINE form only. A named ref leaves it
   * `undefined` — the registry knows the resolver's dependencies, and projecting
   * them to a client is the P2 enumeration concern, not a duplicated field here.
   */
  readonly completeRequires?: readonly string[];
};

// ============================================================================
// Declaration
// ============================================================================

/**
 * The ctx a {@link PromptDeclaration.render} receives: the invoking op's
 * {@link OperationCtx} plus the one facet a render can want that no other
 * starved seam does — the ability to ASK.
 *
 * A prompt is invoked by a person, and the arguments they supplied are
 * frequently not the arguments the prompt needs. `/quoting_report` with no
 * period, `/summarize` pointed at an ambiguous name — a render that can only
 * read `args` must fail, or guess. With `elicit` it can ask the one question
 * and continue, which is what every chat-side prompt UI does and what v1's MCP
 * prompts could already do.
 *
 * **Optional, and a declaration MUST branch on its absence.** Nothing supplies
 * it in a ctx-free render: a unit test calling `decl.render(args)` directly, a
 * doc generator walking the catalog, a snapshot fixture. The absent case is not
 * an error state to guard against — it is the normal shape of "nobody is there
 * to answer", and the honest branch is a default, a placeholder, or a thrown
 * `PromptArgumentMissing`, never a hang:
 *
 * ```ts
 * render: async (args, ctx) => {
 *   const period = (args.period as string | undefined)
 *     ?? (await ctx?.elicit?.text("Which period?", { pattern: "^\\d{4}-\\d{2}$" }))
 *     ?? currentPeriod();
 *   return `Quoting report for ${period}.`;
 * }
 * ```
 *
 * Whether the facet is present at all is the HOST's answer, not the
 * declaration's: it is there when the harness was given an elicit source and
 * the render is running inside a session that can reach a user.
 */
export type PromptRenderCtx = OperationCtx & {
  /**
   * Ask the user a typed question mid-render. The same {@link Elicit} surface a
   * tool handler reads as `ctx.elicit`, so one vocabulary covers both.
   *
   * Absent in a ctx-free render, and absent when no elicit source reached the
   * harness — always `?.`-guarded, never assumed.
   */
  readonly elicit?: Elicit;
};

/**
 * Registration shape for a prompt. Adopters supply EITHER `template`
 * (static; args unused) OR `render` (dynamic; receives validated args).
 * Supplying both is allowed; `render` takes precedence at invoke
 * time. Supplying neither fails at invoke with `PromptMissingContent`.
 *
 * `template` and `render` produce framework-agnostic content via the
 * `unknown` type — concrete adapters (e.g., React via
 * `@agentick/compiler-react`) constrain to `ReactNode` at the
 * factory layer. The spec stays framework-neutral.
 */
export interface PromptDeclaration {
  /** Stable name (snake_case convention). Unique within the harness. */
  readonly name: string;
  /**
   * Human display label, when the name is not one. `jobs_over_budget` is an id;
   * "Jobs Over Budget" is what belongs in a command palette next to it.
   *
   * Distinct from {@link description} on purpose — a palette row wants a LABEL and a
   * subtitle, not one string doing both. Optional because a well-chosen name is often
   * label enough, and a consumer falls back to the name rather than rendering a blank.
   *
   * Mirrors MCP's `title` on `prompts/list`, so a projected remote prompt keeps it. That
   * projection previously collapsed `description ?? title ?? name`, which lost the title
   * of any server supplying both and rendered a title AS a description for a server
   * supplying only one.
   */
  readonly title?: string;
  /** One-line description; shown in command palette / slash list / MCP `prompts/list`. */
  readonly description: string;
  /** Argument descriptors. Empty / omitted → prompt takes no args. */
  readonly arguments?: readonly PromptArgument[];
  /** Static content. Used when `render` is absent. Framework-typed at the adapter layer. */
  readonly template?: unknown;
  /**
   * Dynamic content factory. Receives validated args; returns content
   * the harness compiles into messages. Framework-typed at the
   * adapter layer (React: `(args) => ReactNode`).
   *
   * The optional second parameter is the invoking crossing's {@link
   * PromptRenderCtx} (ADR 91 §2) — the trunk (sessionId / opId / identity), the
   * `log` / `trace` / `metrics` / `run` facets, and the optional `elicit`.
   * Optional in the SIGNATURE (a declaration stays pure and trivially testable);
   * REQUIRED in the LAW — the harness `render` path and the MCP `prompts/get`
   * projection always thread the ctx of the invoking op. A dynamic prompt reads
   * `ctx?.user` / the MCP identity to render per-principal content, and
   * `ctx?.elicit` to ask for what the caller did not supply.
   */
  readonly render?: (args: Readonly<Record<string, unknown>>, ctx?: PromptRenderCtx) => unknown;
  /**
   * WHICH REVISION of this prompt is registered — adopter-defined, never
   * framework-computed.
   *
   * What the string MEANS is entirely yours: a semver, a deploy hash, a date, a
   * row id from the table the declaration was loaded out of. The framework never
   * reads it, never derives it, and never defaults it — it copies it verbatim
   * into the provenance stamp `invoke` puts on the timeline entries it queues, so
   * "which revision of this prompt produced this message" is answerable from the
   * entry alone. Set nothing and everything works, minus that one string.
   *
   * Serializable, so it rides {@link PromptDeclarationRecord} everywhere records
   * already go — `list`, snapshots, the client handle — with no new plumbing.
   *
   * @see docs/proposals/v2/materialization-provenance.md §3
   */
  readonly version?: string;
  /** Adopter-defined metadata (tags, source URL, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Input shapes
// ============================================================================

export interface PromptsRegisterInput {
  readonly declaration: PromptDeclaration;
}

export interface PromptsUpdateInput {
  readonly name: string;
  readonly declaration: Partial<Omit<PromptDeclaration, "name">>;
}

export interface PromptsRemoveInput {
  readonly name: string;
}

/**
 * Invoke a prompt — renders AND appends the messages directly to the
 * session timeline (ADR 53: input appends the moment it exists; there
 * is no queue/drain tier). Nothing RUNS on invoke: the entries sit in
 * the durable timeline until the next `session.send` — which may be a
 * bare send with no messages of its own — starts an execution whose
 * first render sees them.
 */
export interface PromptsInvokeInput {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Get rendered messages WITHOUT queueing. For MCP server `prompts/get`,
 * snapshot tests, doc generators — any consumer that wants the
 * rendered output for external use.
 */
export interface PromptsGetInput {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Ask what a prompt ARGUMENT completes to — the input to
 * {@link PromptsHarnessProtocol.complete}.
 *
 * `context.arguments` is nested rather than flat, and that is MCP parity on
 * purpose: `completion/complete` carries the sibling values under
 * `context.arguments`, so an MCP projection copies the field instead of
 * repacking it. The harness flattens it onto the resolver ctx's
 * `resolvedArguments` (the name the seam itself uses).
 */
export interface PromptsCompleteInput {
  /** The prompt whose argument is being completed. Unknown → `PromptNotFound`. */
  readonly name: string;
  /** Which argument, and the partial value typed so far. */
  readonly argument: { readonly name: string; readonly value: string };
  /** Sibling arguments already filled — what makes conditional completion work. */
  readonly context?: { readonly arguments: Readonly<Record<string, string>> };
  /** Latest-wins cancellation; forwarded to the resolver's ctx. */
  readonly signal?: AbortSignal;
}

/**
 * What {@link PromptsHarnessProtocol.complete} answers with — a three-arm
 * discriminated union rather than a bare {@link CompletionResult}, because
 * prompts holds only ONE of the two halves of the completion split.
 *
 * The prompts harness never runs a registry lookup itself: it declares no
 * runtime dependency on `@agentick/completions` (it holds resolvers, it does not
 * own them), so an argument that names a registry source is answered by handing
 * the NAME back to the caller. The caller — the `completions/complete` wire
 * route, or an adopter with both harnesses in hand — composes the second hop.
 */
export type PromptsCompleteOutcome =
  /** An INLINE resolver from the declaration's sidecar ran; this is its answer. */
  | { readonly kind: "resolved"; readonly result: CompletionResult }
  /**
   * The argument names a registry source this side does not hold. `completeRef`
   * is the name to resolve against the completions registry.
   */
  | { readonly kind: "ref"; readonly completeRef: string }
  /**
   * Nothing to ask. Either the argument declares no completion at all (including
   * an argument name this prompt does not have — completion never
   * protocol-errors on an unknown argument, MCP parity), or it declared an inline
   * resolver whose sidecar entry is gone (a restored session) — the same silence
   * `render` keeps rather than pointing at a ref nothing answers to.
   */
  | { readonly kind: "unavailable" };

export interface PromptsGetResult {
  /** The declaration's own description — useful for MCP `prompts/get` wire shape. */
  readonly description: string;
  /**
   * Rendered messages. Each is a `MessageEntry` (role + content +
   * optional metadata). The render pipeline projects the JSX walker's
   * output through this shape; consumers wanting the MCP wire form
   * project roles further (only `user` / `assistant` / `system` make
   * it onto the wire).
   */
  readonly messages: readonly MessageEntry[];
  /**
   * The DECLARATION's adopter metadata bag, surfaced on the render result.
   *
   * Deliberately not a per-render bag: a render produces messages, and anything
   * it wants to say about them belongs on a message. What a caller holding only
   * a result cannot otherwise reach is what the DECLARATION said about itself —
   * a wire projection reading `prompts/get` has no list record in hand and would
   * otherwise have to look the declaration up again to answer "what did the
   * author attach to this prompt".
   *
   * Same carriage convention as everywhere else metadata travels: a namespaced
   * sub-bag per consumer. MCP's `GetPromptResult._meta` rides
   * `metadata.mcp.meta`, which is the same key `prompts/list` projects from —
   * one authored place, two wire slots.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  PromptAlreadyExists,
  PromptArgumentInvalid,
  PromptArgumentMissing,
  PromptMissingContent,
  PromptNotFound,
  PromptRenderFailed,
  PromptsBackendError,
  PromptsError,
  type PromptsErrorChannel,
} from "../errors/harnesses.js";

// ============================================================================
// Protocol
// ============================================================================

/**
 * The prompts harness protocol. Sync reads + async writes, matching
 * `SkillsHarnessProtocol` / `KnobsHarnessProtocol`.
 *
 * **Sync surface** — cheap reads from local cache; no envelopes.
 * **Async surface** — full Operations through `runOperation`; every
 * mutation + invocation produces `requested → terminal` envelopes
 * adopters and audit tooling can observe.
 *
 * Implementations:
 *   - `PromptsHarness` (in `@agentick/prompts`) — in-memory
 *     reference impl with React render via `renderTemplate`.
 *   - Custom backends — adopters override by registering their own
 *     `SessionExtension` that swaps in a subclass.
 */
/**
 * The prompts harness's **canonical** render surface: the composable Effect
 * twin of the `prompts:render` command (ADR 77, the dual-typed edge). Returns
 * the operation Effect un-run, so an in-process caller composes it with
 * `yield*` and stays in ONE fiber tree; `prompts.render(input)` is the derived
 * Promise facade.
 *
 * ## Why this is on the PROTOCOL, not just the concrete class
 *
 * Same rule as {@link import("./resources-harness.js").ResourcesFx}: the MCP
 * server's prompts projection holds `Prompts` (the protocol) and renders from
 * INSIDE the `mcp:command:get-prompt` crossing operation. Through the Promise
 * facade the render re-enters Effect on a fresh ROOT fiber inheriting no
 * FiberRef, so the declaration's `render(args, ctx)` receives a ctx with no
 * connection identity (ADR 92 §Slice A, the residual ADR 91 stop-rule #2).
 * Composed on the crossing's captured runtime, the chain connection →
 * crossing → `prompts:command:render` → `render(args, ctx)` stays intact.
 *
 * SCOPE: the read path only. `register` / `update` / `remove` / `invoke` are
 * write verbs no in-fiber consumer composes yet; they migrate here when one
 * appears (the `ExecutorFx` precedent — declare what is consumed).
 */
export interface PromptsFx extends HarnessFx {
  /**
   * Render a prompt to messages WITHOUT queueing — the Effect twin of
   * {@link PromptsHarnessProtocol.render}. Runs the declaration's
   * `render(args, ctx)` with the invoking operation's {@link OperationCtx}.
   */
  render(
    input: PromptsGetInput,
  ): Effect.Effect<PromptsGetResult, PromptsErrorChannel | SubstrateError, never>;
  /**
   * Complete one ARGUMENT — the Effect twin of
   * {@link PromptsHarnessProtocol.complete}, and the same three-arm outcome.
   *
   * The MCP server's completions projection composes THIS from inside its
   * `mcp:command:complete` crossing, for the reason `render` is here: the
   * declaration's inline resolver must see the CONNECTION's identity
   * (`ctx.mcp.user` — a completion against tenant data is scoped by the caller,
   * not by whoever owns the registry). The Promise facade mints from the
   * harness's own construction scope, so the resolver would see the session and
   * nothing of the client that asked.
   *
   * Unlike `render`, this is NOT sugar over a declared command — `complete` is
   * deliberately command-less so a keystroke mints no journaled operation. The
   * twin buys the FIBER, not an envelope; neither face journals.
   */
  complete(
    input: PromptsCompleteInput,
  ): Effect.Effect<
    PromptsCompleteOutcome,
    PromptsErrorChannel | CompletionsErrorChannel | SubstrateError,
    never
  >;
}

/**
 * Adopter-facing alias for {@link PromptsHarnessProtocol}. Use this in
 * surface APIs (function signatures, slot types in extension options)
 * so adopters never have to type "Harness" in their code.
 */
export type Prompts = PromptsHarnessProtocol;

/**
 * Structural type guard for a `Prompts` instance. Discriminates the
 * trichotomic adopter slot pattern (array | instance | config object)
 * by checking for the live `PromptsHarnessProtocol` method surface.
 *
 * A `Prompts` instance has all of `register`, `update`, `remove`,
 * `list`, `subscribeAll`, `invoke`, `get`. None of these appear on a
 * `PromptsRegisterInput[]` shorthand or a plain config object. Order
 * matters in the discriminator: test for arrays first, then
 * `isPromptsInstance`, then fall through to the config-object form.
 */
export function isPromptsInstance(v: unknown): v is Prompts {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.register === "function" &&
    typeof obj.update === "function" &&
    typeof obj.remove === "function" &&
    typeof obj.list === "function" &&
    typeof obj.subscribeAll === "function" &&
    typeof obj.invoke === "function" &&
    typeof obj.get === "function"
  );
}

export interface PromptsHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  /**
   * The Effect-canonical render surface (ADR 77, the dual-typed edge) — the
   * twin an in-fiber caller composes with `yield*`. On the PROTOCOL so a
   * protocol-typed ref (the MCP server's prompts projection) can compose
   * without severing the fiber at the Promise facade. See {@link PromptsFx}.
   */
  readonly fx: PromptsFx;
  close(): Promise<void>;

  // ─── Sync surface ─────────────────────────────────────────────

  /**
   * Look up a prompt declaration by name (the sync family-grammar `get`).
   * NOT the render — `render(input)` produces messages.
   */
  get(name: string): PromptDeclaration | undefined;
  /** True iff a prompt with this name is registered. */
  has(name: string): boolean;
  /** Enumerate every registered prompt declaration. */
  list(): readonly PromptDeclaration[];
  /** Notify when a specific prompt's declaration changes. */
  subscribe(name: string, listener: () => void): Unsubscribe;
  /** Notify when any prompt changes (register / update / remove). */
  subscribeAll(listener: () => void): Unsubscribe;

  // ─── Async surface ────────────────────────────────────────────

  /** Register a new prompt. Fails `PromptAlreadyExists` on name collision. */
  register(input: PromptsRegisterInput): Promise<PromptDeclaration>;
  /** Partial update. Fails `PromptNotFound` if missing. */
  update(input: PromptsUpdateInput): Promise<PromptDeclaration>;
  /** Remove a prompt. Idempotent. */
  remove(input: PromptsRemoveInput): Promise<void>;
  /**
   * Render + queue. Validates args, calls `render(args)` (or uses
   * `template`), compiles to messages via the adapter's renderer,
   * queues them onto the session timeline. Returns the rendered
   * messages for the caller's own inspection / logging.
   */
  invoke(input: PromptsInvokeInput): Promise<PromptsGetResult>;
  /**
   * Render WITHOUT queueing. For the MCP server `prompts/get` projection,
   * snapshot tests, doc generators. (The sync `get(name)` above is the
   * declaration read — this is the render, hence `render`.)
   */
  render(input: PromptsGetInput): Promise<PromptsGetResult>;
  /**
   * Complete one ARGUMENT of a prompt — what a composer offers while the user
   * types into a slot.
   *
   * A plain async method, NOT a declared command, and for the same reason
   * `CompletionsHarnessProtocol.resolve` is not one: completion fires per
   * keystroke, so one journaled operation per character typed would flood the
   * recovery/audit spine with ephemeral queries. See the doc-block on
   * {@link import("./completions-harness.js").CompletionsHarnessProtocol}.
   *
   * Answers the {@link PromptsCompleteOutcome} union — inline resolvers run here,
   * a named registry ref comes back as a name for the caller to resolve, and an
   * argument with nothing to ask is `unavailable`.
   *
   * @throws {PromptNotFound} no prompt is registered under `input.name`. An
   *   unknown ARGUMENT name is NOT an error — it is `unavailable`.
   * @throws {CompletionResolveFailed} an inline resolver threw or rejected.
   */
  complete(input: PromptsCompleteInput): Promise<PromptsCompleteOutcome>;
}

/**
 * The **serializable slice** of a {@link PromptDeclaration} — the persisted
 * record the {@link import("./prompts-store.js").PromptStore} holds. It is `PromptDeclaration` MINUS its non-serializable
 * runtime-augmentation fields (`template`, `render`, and each argument's
 * `complete` resolver — see {@link PromptArgumentRecord}): the prompts harness is
 * the definition-library archetype's first **augmented instance** — skills' pure
 * record PLUS a non-persisted `{ template, render, completions }` sidecar
 * (data-layer plan §6-C / Phase 5). The store round-trips this record whole; the
 * augmentation lives in a parallel harness-local map and is re-registered by
 * re-declaration at mount (fns cannot survive serialization).
 *
 */
export interface PromptDeclarationRecord {
  readonly name: string;
  /** See {@link PromptDeclaration.title} — a display label, distinct from the subtitle. */
  readonly title?: string;
  readonly description: string;
  /** Record-safe descriptors: `complete` traded for `completeRef` / `completeRequires`. */
  readonly arguments?: readonly PromptArgumentRecord[];
  /** See {@link PromptDeclaration.version} — the adopter's revision string, carried verbatim. */
  readonly version?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
