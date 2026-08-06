/**
 * `createClientTool` — one object carrying both halves of a client-executed
 * tool, so they cannot be authored apart.
 *
 * The declaration sent to the server is a PROJECTION of this object, never
 * authored: `set` drops `handler`/`accepts` and runs `inputSchema` through
 * `toJsonSchema`. A declaration with no handler and a handler with no
 * declaration both become unconstructable.
 *
 * @see docs/proposals/v2/client-tools.md §"Layer 4"
 */

import {
  toJsonSchema,
  type ClientToolAnnotations,
  type ClientToolDeclaration,
  type ClientRuntimeContext,
  type ProgressUpdate,
  type StandardSchemaV1,
  type ToolResultInput,
} from "@agentick/spec";

/** Which connection asked, and what it said about itself at handshake. */
export interface ClientToolOrigin {
  readonly connectionId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Per-harness additions to {@link ClientToolCtx}, following ADR 27 — built-ins
 * are not privileged. A client-side harness package augments this the way a
 * server harness augments `ToolHandlerCtxExtensions`:
 *
 * ```ts
 * declare module "@agentick/tool-executor/client" {
 *   interface ClientToolCtxExtensions { elicit: ClientElicitor }
 * }
 * ```
 */
export interface ClientToolCtxExtensions {}

/**
 * What a client tool's handler receives.
 *
 * Deliberately narrow. Server-side `use()` exists because a handler runs at
 * dispatch and cannot reach render-time context; in a browser the handler is
 * authored inside the app and already closes over the router, the injector and
 * the stores. So this carries only what the framework alone knows — anything an
 * adopter's closure can reach stays out, or ctx becomes a service locator.
 */
export interface ClientToolCtx extends ClientRuntimeContext, ClientToolCtxExtensions {
  readonly toolCallId: string;
  readonly name: string;
  /** The connection this call was addressed to, when it carries one. */
  readonly target?: string;
  readonly origin?: ClientToolOrigin;
  /** Aborted when the execution dies. A tool mid-`fetch` must honour it. */
  readonly signal: AbortSignal;
  readonly progress?: (update: ProgressUpdate) => void;
}

/**
 * What {@link ClientTool.accepts} receives — narrower than the handler's ctx on
 * purpose.
 *
 * No `log`, no `trace`, no `progress`. This predicate runs in EVERY attached
 * client, so a side effect here multiplies by tab count. It gets `input`
 * because acceptance can legitimately depend on the arguments.
 */
export interface ClientToolAcceptCtx {
  readonly name: string;
  readonly input: unknown;
  /** This connection's id. Compare against `target` to answer "is it me?". */
  readonly self: string;
  readonly target?: string;
  readonly origin?: ClientToolOrigin;
}

/** A client tool: the declaration and the handler, joined. */
export interface ClientTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StandardSchemaV1<unknown, TInput>;
  readonly aliases?: readonly string[];
  readonly annotations?: ClientToolAnnotations;
  /**
   * Whether THIS client should run the call. Default: accept.
   *
   * Several connections attach to one session and the tool-call channel reaches
   * all of them, so without a rule four tabs run `navigate_to` and four tabs
   * navigate. The right rule differs per tool and only the author knows it —
   * `navigate_to` wants the addressed connection, `read_selection` wants the
   * focused one, a toast wants everybody:
   *
   * ```ts
   * accepts: ({ target, self }) => target === undefined || target === self
   * accepts: () => document.hasFocus()
   * ```
   *
   * Declining is SILENT and correct — it is not the same as not knowing the
   * tool, and it must never reach `notFound`.
   */
  readonly accepts?: (ctx: ClientToolAcceptCtx) => boolean;
  /**
   * Runs the call. Takes ctx FLAT as the second argument, unlike the server's
   * `(input, { ctx })` — that envelope exists to merge `use()` deps, and the
   * client has no `use()` to merge.
   */
  readonly handler: (
    input: TInput,
    ctx: ClientToolCtx,
  ) => ToolResultInput | Promise<ToolResultInput>;
}

export function createClientTool<TInput = unknown>(tool: ClientTool<TInput>): ClientTool<TInput> {
  return tool;
}

/** The wire declaration for a tool — what the server is told, and nothing more. */
export function toClientToolDeclaration(tool: ClientTool<never>): ClientToolDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    ...(tool.aliases !== undefined ? { aliases: tool.aliases } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}
