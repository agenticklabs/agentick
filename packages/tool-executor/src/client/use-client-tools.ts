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
import { reasonOf } from "@agentick/utils";

import type { ClientToolCall, ClientToolCallHandle } from "./client-tool-calls.js";
import type { Tool, ToolCtx, ToolCtxExtensions } from "./create-tool.js";

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
  /**
   * Fills the adopter's own {@link ToolCtxExtensions} slots, evaluated PER
   * DISPATCH against the call. Read the app's state at the moment the call
   * arrives — which session is in view, who is signed in — rather than at the
   * moment the tools were bound, which is a different answer.
   *
   * Framework fields (`toolCallId`, `name`, `sessionId`, `signal`, …) are
   * applied over the result: ctx is extended here, never rewritten.
   */
  readonly ctx?: (call: ClientToolCall) => ToolCtxExtensions;
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

  const ctx = clientToolCtx(call, runtime, signal, opts.ctx);

  const run =
    tool !== undefined
      ? () => tool.handler(call.input as never, ctx)
      : () => (opts.notFound ?? unknownTool)(call.input, ctx);

  return settleHandler(run, call.name);
}

function unreported(name: string): ToolResultInput {
  return (
    `\`${name}\` ran in the browser and reported no outcome, so whether it took ` +
    `effect is unknown. Do not tell the user it succeeded.`
  );
}

/**
 * Run a handler and turn ANY outcome into something sendable.
 *
 * The one place a browser handler's failure becomes a result, shared by both
 * dispatch paths. They each had their own copy and drifted: `use` coerced a
 * nothing-return and `route` sent `undefined` on the wire, which is not a
 * result the executor can normalize — so the reply failed, and a tool that
 * merely returned nothing hung the whole execution.
 *
 * A client-handled call suspends the server until it is answered. Silence here
 * is not a failed tool call, it is a dead conversation.
 */
export async function settleHandler(
  run: () => ToolResultInput | Promise<ToolResultInput>,
  name: string,
): Promise<ToolResultInput> {
  try {
    const result = await run();
    // A handler that answered with nothing is UNKNOWN, not success. Saying so
    // beats both alternatives: silence hangs the call, and the model's default
    // reading of a result with no complaint in it is "it worked".
    return result ?? unreported(name);
  } catch (cause) {
    // Everything lands here, including a RangeError from a walker that
    // exhausted the stack — by the time it propagates the stack has unwound,
    // so the catch has room to run.
    return { content: `\`${name}\` failed in the browser: ${reasonOf(cause)}`, isError: true };
  }
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
  contribute?: (call: ClientToolCall) => ToolCtxExtensions,
): ToolCtx {
  return {
    ...runtime,
    ...contribute?.(call),
    activeSpan: () => runtime.activeSpan(),
    toolCallId: call.toolCallId,
    name: call.name,
    sessionId: call.sessionId,
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
    })().catch((cause: unknown) => {
      // A handler THROW never lands here — `dispatchClientToolCall` turns that
      // into an error result. This is the reply itself failing to reach the
      // server: a socket mid-reconnect, a gateway blip.
      //
      // It used to vanish into the `void`, and that is how a one-second
      // transport hiccup became a session that never answers again — the
      // handler ran, the browser showed its result, and the execution stayed
      // suspended with nothing anywhere saying why.
      //
      // The call is NOT dropped from `list()`: it is still correlated and still
      // answerable, so a client that reconnects can retry it. Losing it here
      // would remove the only recovery path.
      runtime.log.error({
        msg: "client tool reply did not reach the server; the call is still pending",
        tool: call.name,
        toolCallId: call.toolCallId,
        correlationId: call.correlationId,
        reason: reasonOf(cause),
      });
    });
  });
}
