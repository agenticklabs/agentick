/**
 * Dispatch inbound client-tool calls to {@link Tool}s — the consumer that gives
 * `handler` and `notFound` their meaning.
 *
 * `route(handlers)` (the older surface) takes a bare name → function map and
 * always answers. This takes whole tools, so the declaration published to the
 * server and the handler that runs are the same object, and it knows how to
 * stay silent.
 *
 * @see packages/tool-executor/README.md §"When the user has several tabs open"
 */

import type { ClientRuntimeContext, ToolResultInput, Unsubscribe } from "@agentick/spec";

import type { ClientToolCallHandle } from "./client-tool-calls.js";
import type { Tool, ToolCtx } from "./create-tool.js";

/**
 * This client's own id, read at DISPATCH time rather than captured — the
 * server BINDS it at handshake and may hand back a different one than was
 * claimed, so a value captured at construction can be the wrong one.
 */
type SelfId = () => string;

export interface UseClientToolsOptions {
  /**
   * Answers a call naming a tool this client did not declare. Default: an error
   * result reading `no client handler for "<name>"`.
   *
   * NOT reached by a call addressed to a DIFFERENT client — that silence is the
   * design, and reporting it as unknown would turn three correctly-quiet tabs
   * into three warnings about a working system.
   */
  readonly notFound?: (input: unknown, ctx: ToolCtx) => ToolResultInput | Promise<ToolResultInput>;
}

/** Resolves a tool by the name (or alias) a call arrived under. */
function resolve(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name || t.aliases?.includes(name) === true);
}

/**
 * Returned by {@link dispatchClientToolCall} when the call was addressed to a
 * different client and this one must send nothing.
 *
 * A distinct sentinel, NOT `undefined`: a handler that returns nothing (easy
 * from untyped JS, where the return type is not enforced) would otherwise be
 * indistinguishable from a decline, and the call would hang to timeout.
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
  tools: readonly Tool[],
  self: SelfId,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts: UseClientToolsOptions = {},
): Promise<ClientToolOutcome> {
  const tool = resolve(tools, call.name);

  // EVERY attached client receives EVERY call — the channel is a broadcast and
  // stays one. What differs is what each does with it locally, and this is that
  // decision: run it if it was addressed to me, or if it was addressed to
  // nobody in particular.
  //
  // Not an adopter predicate. A rule evaluated independently by N clients can
  // only be sound when it compares against a single value the server chose,
  // and getting that right is not something to ask every tool author to
  // rediscover.
  if (call.target !== undefined && call.target !== self()) return DECLINED;

  const ctx = clientToolCtx(call, runtime, signal);

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

const unknownTool = (_input: unknown, ctx: ToolCtx): ToolResultInput => ({
  content: `no client handler for "${ctx.name}"`,
  isError: true,
});

/**
 * The ctx a client-tool handler receives, built from the call and the client's
 * own runtime.
 *
 * Shared by BOTH dispatch paths. `route` used to hand its handlers a two-field
 * stub while `use` handlers got the real thing — the same handler moved between
 * them silently lost `log`, `trace`, `signal` and `target`.
 */
export function clientToolCtx(
  call: ClientToolCallHandle,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
): ToolCtx {
  return {
    ...runtime,
    activeSpan: () => runtime.activeSpan(),
    toolCallId: call.toolCallId,
    name: call.name,
    ...(call.target !== undefined ? { target: call.target } : {}),
    signal,
  };
}

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
  tools: readonly Tool[],
  self: SelfId,
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
