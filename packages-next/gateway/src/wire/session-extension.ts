/**
 * `sessionWireExtension` — framework-supplied `WireExtension` that
 * projects the `session/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Part of the ADR 46 eat-our-own-dogfood commitment (#295 Phase C +
 * #303 streaming primitives). Post-#303, `session/send` uses
 * `ctx.transport.progress(...)` and `ctx.transport.registerCancel(...)`
 * to bridge to the connection's `DispatchSink` — no direct sink
 * access needed.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  defineWireExtension,
  progressEventQuery,
  SessionNotFoundError,
  toClientToolRegistration,
  type ProtocolEvent,
  type SessionHarnessProtocol,
  type ToolExecutorProtocol,
  type WireExtension,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

/**
 * Structural view of the session's tool executor seam. The gateway is
 * harness-agnostic — it does NOT depend on `@agentick/tool-executor-next` — so
 * (exactly like the `elicitation` cast below) it narrows the session to the
 * public `toolExecutor` member at the call site. Every conforming session that
 * speaks these wire methods exposes it (`SessionHarness.toolExecutor`).
 */
type SessionWithTools = SessionHarnessProtocol & {
  readonly toolExecutor: ToolExecutorProtocol;
};

function findSession(
  ctx: { gateway: { apps(): readonly { getSession(id: string): unknown }[] } },
  sessionId: string,
): SessionHarnessProtocol {
  for (const app of ctx.gateway.apps()) {
    const s = app.getSession(sessionId) as SessionHarnessProtocol | undefined;
    if (s) return s;
  }
  throw new SessionNotFoundError({ sessionId });
}

export const sessionWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway-next#session",
  namespace: "session",
  version: "1.0.0",
  methods: {
    "session/send": async (params, ctx) => {
      const sess = ctx.session ?? findSession(ctx, params.sessionId);
      const progressToken = params._meta?.progressToken;

      const handle = await sess.send({
        messages: params.messages,
        props: params.props,
        metadata: params.metadata,
        maxTicks: params.maxTicks,
        stream: params.stream,
        target: params.target,
        // 4b — steer/follow-up delivery. A JSON-clean string enum threads
        // straight through; the session owns the semantics.
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      });

      // Register cancellation seam — `notifications/cancelled` from
      // the client aborts the underlying execution handle. The
      // dispatcher clears the in-flight entry when the RPC returns.
      ctx.transport.registerCancel(() => {
        void handle.abort("client cancelled");
      });

      // LSP-style progress: opt-in via `_meta.progressToken`. When
      // set, fan out `notifications/progress` frames from TWO sources
      // onto the same caller-supplied token:
      //   (1) the handle's execution-event stream (lifecycle liveness);
      //   (2) ADR 64 `ctx.progress` SIGNALS — a tool (or any harness)
      //       emitting `<surface>:signal:progress` bus events scoped to
      //       THIS execution. Both ride the existing per-token progress
      //       stream (no new transport plumbing — ADR 64 §"progress
      //       reuses the existing stream").
      let stopSignalDrain: (() => void) | undefined;
      if (progressToken !== undefined) {
        const reporter = ctx.transport.progress(progressToken);

        // (1) Execution-event fan-out. Envelope-local counter — separate
        // from the wire's outer `cursor` (managed inside the reporter).
        // Preserves the pre-refactor envelope `id: "progress-N"` shape so
        // downstream consumers keying on `envelope.id` (devtools
        // inspectors, MCP wire codec) don't regress.
        let n = 0;
        (async () => {
          try {
            for await (const event of handle.events()) {
              n++;
              reporter.push({
                id: `progress-${n}`,
                surface: "session",
                name: "session:execution:event",
                phase: "started",
                timestamp: Date.now(),
                scope: { sessionId: sess.id },
                payload: event,
              });
            }
          } catch {
            /* result-Promise below carries the failure — progress is best-effort */
          }
        })();

        // (2) Progress-SIGNAL fan-out (ADR 64 / #19-progress-wire). The
        // gateway bus is the fan-in root — every child harness's signal
        // reaches it, so `ctx.gateway.events(...)` observes a tool's
        // `ctx.progress(...)`. Scope to the execution id so concurrent
        // executions on the same session never cross-contaminate. Push
        // the raw signal envelope (self-describing: `name` is
        // `<surface>:signal:progress`, `payload` is the ProgressEventPayload)
        // so the client can discriminate it from execution events. Torn
        // down when the send settles — the gateway bus outlives this RPC,
        // so the subscription must be explicitly stopped.
        const signalEvents = ctx.gateway.events({
          ...progressEventQuery(),
          scope: { executionId: handle.executionId },
        });
        const signalIter = signalEvents[Symbol.asyncIterator]();
        stopSignalDrain = () => {
          void signalIter.return?.(undefined);
        };
        (async () => {
          try {
            for (
              let step = await signalIter.next();
              step.done !== true;
              step = await signalIter.next()
            ) {
              reporter.push(step.value as ProtocolEvent);
            }
          } catch {
            /* best-effort — progress is never a control path (ADR 64) */
          }
        })();
      }

      try {
        const result = await handle.result;
        return {
          executionId: handle.executionId,
          finalCursor: { value: 0 },
          result,
        };
      } finally {
        // Stop the signal drain regardless of success/failure so the
        // background subscription doesn't outlive the RPC.
        stopSignalDrain?.();
      }
    },
    "session/dispatch": async ({ sessionId, tool, input }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const content = await sess.dispatch(tool, input as Record<string, unknown>);
      return { content };
    },
    "session/abort": async ({ sessionId }, ctx) => {
      // Stub-only today: SessionHarnessProtocol exposes abort() on the
      // returned SessionExecutionHandle, not on the session itself.
      // Full wiring requires per-session active-handle tracking on the
      // transport server adapter — see #303 for the streaming
      // primitives that will land the tracking.
      const sess = ctx.session ?? findSession(ctx, sessionId);
      void sess;
      return null;
    },
    "session/close": async ({ sessionId }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      await sess.close();
      return null;
    },
    "session/respond_to_elicitation": async (params, ctx) => {
      const sess = ctx.session ?? findSession(ctx, params.sessionId);
      // The elicitation slot on SessionHarnessProtocol is augmented in
      // by `@agentick/elicitation-next`. Gateway package intentionally
      // does NOT depend on elicitation-next; cast to the augmented
      // shape at the call site. Every conforming session that speaks
      // this wire method has the slot.
      const sessElic = sess as SessionHarnessProtocol & {
        readonly elicitation: {
          respond(input: {
            readonly correlationId: string;
            readonly outcome: "accepted" | "declined" | "cancelled";
            readonly value?: unknown;
            readonly reason?: string;
          }): Promise<void>;
        };
      };
      await sessElic.elicitation.respond({
        correlationId: params.correlationId,
        outcome: params.outcome,
        ...omitUndefined({ value: params.value, reason: params.reason }),
      });
      return null;
    },
    "session/set_client_tools": async (params, ctx) => {
      const sess = (ctx.session ?? findSession(ctx, params.sessionId)) as SessionWithTools;
      const binding = { scope: "client", sessionId: params.sessionId } as const;
      // DECLARATIVE whole-slice replace — the wire twin of the compiler's
      // `replaceCompilerTools`. A client is a declarative tool SOURCE that
      // owns the `{ scope: "client", sessionId }` slice: it declares its FULL
      // set, and we replace the slice wholesale. This subsumes register (in the
      // set), unregister (absent), and idempotency (it's a replace). The client
      // slice is held DISTINCT from `{ scope: "session" }` — clearing it never
      // clobbers the app's `createSession({ tools })` slice.
      //
      // Clear the client slice first, then reinstall the declared set. Each
      // declaration folds into a CLIENT-HANDLED registration via
      // `toClientToolRegistration` (raw JSON-Schema `inputSchema` wrapped into a
      // validator; `handlerRef` omitted ⇒ client-handled). Session-lifetime:
      // the session-close cleanup reaps the client slice.
      await sess.toolExecutor.removeBoundTools({ binding });
      for (const declaration of params.declarations) {
        const registration = toClientToolRegistration(declaration, binding);
        await sess.toolExecutor.register({ registration });
      }
      return { count: params.declarations.length };
    },
    "session/respond_to_tool_call": async (params, ctx) => {
      const sess = (ctx.session ?? findSession(ctx, params.sessionId)) as SessionWithTools;
      // Same suspend-resume path as `respond_to_elicitation`: the executor
      // routes the result through its inbox as a `request-response` envelope,
      // resolving the pending `this.request(TOOL_CALL_CHANNEL, …)` the
      // client-handled dispatch is blocked on.
      await sess.toolExecutor.respondToToolCall({
        correlationId: params.correlationId,
        result: params.result,
      });
      return null;
    },
  },
});
