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
import type { ClientTool, ClientToolCtx } from "./create-client-tool.js";

/**
 * This client's own connection id, read at DISPATCH time rather than captured:
 * a reconnect mints a new one, and a stale `self` makes every `target === self`
 * rule wrong for the rest of the session.
 */
export type ClientToolSelf = () => string;

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
function resolve(tools: readonly ClientTool[], name: string): ClientTool | undefined {
  return tools.find((t) => t.name === name || t.aliases?.includes(name) === true);
}

/**
 * Returned by {@link dispatchClientToolCall} when this client declines the call
 * and must send nothing.
 *
 * A distinct sentinel, NOT `undefined`: a handler that returns nothing (easy
 * from untyped JS, where the return type is not enforced) would otherwise be
 * indistinguishable from a decline, and the call would hang to timeout — the
 * exact failure the decline path exists to avoid.
 */
export const DECLINED: unique symbol = Symbol("agentick.clientTool.declined");

/** What a dispatch resolves to: a result to send, or {@link DECLINED}. */
export type ClientToolOutcome = ToolResultInput | typeof DECLINED;

/**
 * Run one inbound call against the tool set. Resolves to the result to send, or
 * {@link DECLINED} when this client is not the one to answer.
 */
export async function dispatchClientToolCall(
  call: ClientToolCallHandle,
  tools: readonly ClientTool[],
  self: ClientToolSelf,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts: UseClientToolsOptions = {},
): Promise<ClientToolOutcome> {
  const tool = resolve(tools, call.name);

  if (tool?.accepts !== undefined) {
    const accepted = tool.accepts({
      name: call.name,
      input: call.input,
      self: self(),
      ...(call.target !== undefined ? { target: call.target } : {}),
    });
    if (!accepted) return DECLINED;
  }

  const ctx: ClientToolCtx = {
    ...runtime,
    activeSpan: () => runtime.activeSpan(),
    toolCallId: call.toolCallId,
    name: call.name,
    ...(call.target !== undefined ? { target: call.target } : {}),
    signal,
  };

  const run =
    tool !== undefined
      ? () => tool.handler(call.input as never, ctx)
      : () => (opts.notFound ?? unknownTool)(call.input, ctx);

  try {
    const result = await run();
    // A handler that answered with nothing is UNKNOWN, not success. Saying so
    // beats both alternatives: silence hangs the call, and the model's default
    // reading of a result with no complaint in it is "it worked".
    return result ?? unreported(call.name);
  } catch (err) {
    return {
      content: `\`${call.name}\` failed in the browser: ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }
}

function unreported(name: string): ToolResultInput {
  return (
    `\`${name}\` ran in the browser and reported no outcome, so whether it took ` +
    `effect is unknown. Do not tell the user it succeeded.`
  );
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
  tools: readonly ClientTool[],
  self: ClientToolSelf,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts: UseClientToolsOptions = {},
): Unsubscribe {
  return feed.onCall((call) => {
    void (async () => {
      const outcome = await dispatchClientToolCall(call, tools, self, runtime, signal, opts);
      if (outcome !== DECLINED) await call.respond(outcome);
    })();
  });
}
