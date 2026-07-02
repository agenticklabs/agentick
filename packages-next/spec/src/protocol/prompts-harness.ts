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

import type { MessageEntry } from "../data/entries.js";
import type { StandardSchemaV1 } from "../data/standard-schema.js";
import type { Unsubscribe } from "./inbox.js";

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
}

// ============================================================================
// Declaration
// ============================================================================

/**
 * Registration shape for a prompt. Adopters supply EITHER `template`
 * (static; args unused) OR `render` (dynamic; receives validated args).
 * Supplying both is allowed; `render` takes precedence at invoke
 * time. Supplying neither fails at invoke with `PromptMissingContent`.
 *
 * `template` and `render` produce framework-agnostic content via the
 * `unknown` type — concrete adapters (e.g., React via
 * `@agentick/reconciler-react-next`) constrain to `ReactNode` at the
 * factory layer. The spec stays framework-neutral.
 */
export interface PromptDeclaration {
  /** Stable name (snake_case convention). Unique within the harness. */
  readonly name: string;
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
   */
  readonly render?: (args: Readonly<Record<string, unknown>>) => unknown;
  /** Adopter-defined metadata (version, tags, source URL, etc.). */
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
 * Invoke a prompt — produces messages AND queues them onto the
 * session timeline (via `bridges.timeline.queue`, same path explicit
 * user input takes). On the next `session.send`, queued messages
 * drain into the durable timeline before the first tick.
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
 *   - `PromptsHarness` (in `@agentick/prompts-next`) — in-memory
 *     reference impl with React render via `renderTemplate`.
 *   - Custom backends — adopters override by registering their own
 *     `SessionExtension` that swaps in a subclass.
 */
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
  close(): Promise<void>;

  // ─── Sync surface ─────────────────────────────────────────────

  /** Look up a prompt declaration by name. */
  getDeclaration(name: string): PromptDeclaration | undefined;
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
   * Render WITHOUT queueing. For MCP server `prompts/get`, snapshot
   * tests, doc generators.
   */
  get(input: PromptsGetInput): Promise<PromptsGetResult>;

  // ─── Snapshot / restore (SnapshotCapable feature) ──────────────

  /**
   * Export every prompt for hibernate / cross-session transfer.
   * `template` and `render` fields are NOT serializable — the
   * snapshot carries declarations sans-content. Restoring requires
   * re-registering the content via `withPrompts({ initial })` or
   * direct `register` calls; the harness preserves names + arguments
   * + description + metadata so the agent's "available prompts" list
   * survives.
   */
  exportSnapshot(): Readonly<Record<string, PromptsSnapshotEntry>>;
  /** Import a snapshot. Replaces the current cache wholesale. */
  importSnapshot(snapshot: Readonly<Record<string, PromptsSnapshotEntry>>): void;
}

/**
 * Snapshot shape for a single prompt. Excludes `template` + `render`
 * (functions / React nodes aren't serializable). Adopters who want
 * full round-trip on restore re-register content alongside loading
 * the snapshot.
 */
export interface PromptsSnapshotEntry {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly PromptArgument[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Inbox message catalog
// ============================================================================

/**
 * Typed inbox messages routed to a PromptsHarness instance. Cluster
 * peers, admin dashboards, sibling harnesses send these via
 * `inbox.send("prompts:<scopeId>", { type, payload, messageId })`.
 */
export type PromptsInboxMessage =
  | { readonly type: "prompts:register"; readonly payload: PromptsRegisterInput }
  | { readonly type: "prompts:update"; readonly payload: PromptsUpdateInput }
  | { readonly type: "prompts:remove"; readonly payload: PromptsRemoveInput }
  | { readonly type: "prompts:invoke"; readonly payload: PromptsInvokeInput };
