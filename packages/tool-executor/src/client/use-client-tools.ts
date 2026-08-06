/**
 * Dispatch inbound client-tool calls to {@link ClientTool}s — the consumer that
 * gives `handler`, `accepts` and `notFound` their meaning.
 *
 * `route(handlers)` (the older surface) takes a bare name → function map and
 * always answers. This takes whole tools, so the declaration published to the
 * server and the handler that runs are the same object, and it knows how to
 * stay silent.
 *
 * @see docs/proposals/v2/client-tools.md §"Two silences, which must not be confused"
 */

import type { ClientRuntimeContext, ToolResultInput, Unsubscribe } from "@agentick/spec";

import type { ClientToolCallHandle } from "./client-tool-calls.js";
import type { ClientTool, ClientToolCtx, ClientToolOrigin } from "./create-client-tool.js";

/** What a call carries about who it came from and who it is for. */
export interface ClientToolAddressing {
  readonly self: string;
  readonly target?: string;
  readonly origin?: ClientToolOrigin;
}

export interface UseClientToolsOptions {
  /**
   * Answers a call naming a tool this client did not declare. Default: an error
   * result reading `no client handler for "<name>"`.
   *
   * NOT reached by a tool whose {@link ClientTool.accepts} returned false — that
   * is a client declining a tool it has, and reporting it as unknown would turn
   * three correctly-silent tabs into three warnings about a working system.
   */
  readonly notFound?: (
    input: unknown,
    ctx: ClientToolCtx,
  ) => ToolResultInput | Promise<ToolResultInput>;
}

/** Resolves a tool by the name (or alias) a call arrived under. */
function resolve(tools: readonly ClientTool<never>[], name: string): ClientTool<never> | undefined {
  return tools.find((t) => t.name === name || t.aliases?.includes(name) === true);
}

/**
 * Run one inbound call against the tool set. Resolves to the result to send, or
 * `undefined` when this client declines and must stay silent.
 */
export async function dispatchClientToolCall(
  call: ClientToolCallHandle,
  tools: readonly ClientTool<never>[],
  addressing: ClientToolAddressing,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts: UseClientToolsOptions = {},
): Promise<ToolResultInput | undefined> {
  const tool = resolve(tools, call.name);

  if (tool?.accepts !== undefined) {
    const accepted = tool.accepts({
      name: call.name,
      input: call.input,
      self: addressing.self,
      ...(addressing.target !== undefined ? { target: addressing.target } : {}),
      ...(addressing.origin !== undefined ? { origin: addressing.origin } : {}),
    });
    if (!accepted) return undefined;
  }

  const ctx: ClientToolCtx = {
    ...runtime,
    activeSpan: () => runtime.activeSpan(),
    toolCallId: call.toolCallId,
    name: call.name,
    ...(addressing.target !== undefined ? { target: addressing.target } : {}),
    ...(addressing.origin !== undefined ? { origin: addressing.origin } : {}),
    signal,
  };

  const run =
    tool !== undefined
      ? () => tool.handler(call.input as never, ctx)
      : () => (opts.notFound ?? unknownTool)(call.input, ctx);

  try {
    return await run();
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

const unknownTool = (_input: unknown, ctx: ClientToolCtx): ToolResultInput => ({
  content: `no client handler for "${ctx.name}"`,
  isError: true,
});

/** The tool-call feed this consumer needs — a floor, so the full handle satisfies it. */
export interface ClientToolCallFeed {
  onCall(listener: (call: ClientToolCallHandle) => void): Unsubscribe;
}

/**
 * Subscribe `tools` to a call feed. A declined call is left unanswered — another
 * attached client is expected to take it.
 */
export function routeClientTools(
  feed: ClientToolCallFeed,
  tools: readonly ClientTool<never>[],
  addressing: ClientToolAddressing,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts: UseClientToolsOptions = {},
): Unsubscribe {
  return feed.onCall((call) => {
    void (async () => {
      const result = await dispatchClientToolCall(call, tools, addressing, runtime, signal, opts);
      if (result !== undefined) await call.respond(result);
    })();
  });
}
