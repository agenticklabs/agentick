/**
 * `createClientTool` — one object carrying both halves of a client-executed
 * tool, so they cannot be authored apart.
 *
 * The declaration sent to the server is a PROJECTION of this object, never
 * authored: `use` drops the `handler` and runs `inputSchema` through
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
  /**
   * The client this call was addressed to — whoever asked for the turn.
   * `undefined` when the execution had no asking client (a cron run, a spawn).
   */
  readonly target?: string;
  /** Aborted when the execution dies. A tool mid-`fetch` must honour it. */
  readonly signal: AbortSignal;
  readonly progress?: (update: ProgressUpdate) => void;
}

/** A client tool: the declaration and the handler, joined. */
export interface ClientTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StandardSchemaV1<unknown, TInput>;
  readonly aliases?: readonly string[];
  readonly annotations?: ClientToolAnnotations;
  /**
   * Runs the call. Takes ctx FLAT as the second argument, unlike the server's
   * `(input, { ctx })` — that envelope exists to merge `use()` deps, and the
   * client has no `use()` to merge.
   *
   * Declared as a METHOD rather than a property so its parameter is checked
   * bivariantly: a `ClientTool<{ to: string }>` has to fit in the
   * `readonly ClientTool[]` that `use` takes, and a property signature makes
   * that array unassignable under `strictFunctionTypes` — pushing a cast onto
   * every adopter for a collection that is heterogeneous by design.
   */
  handler(input: TInput, ctx: ClientToolCtx): ToolResultInput | Promise<ToolResultInput>;
}

export function createClientTool<TInput = unknown>(tool: ClientTool<TInput>): ClientTool<TInput> {
  return tool;
}

/** The wire declaration for a tool — what the server is told, and nothing more. */
export function toClientToolDeclaration(tool: ClientTool): ClientToolDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    ...(tool.aliases !== undefined ? { aliases: tool.aliases } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}
