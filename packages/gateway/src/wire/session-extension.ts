/**
 * `sessionWireExtension` — framework-supplied `WireExtension` that
 * projects the `session/*` namespace over the Agentick client↔gateway
 * wire.
 *
 * Part of the ADR 46 eat-our-own-dogfood commitment (#295 Phase C +
 * #303 streaming primitives). Post-#303, `session/send` uses
 * `ctx.wire.progress(...)` and `ctx.wire.registerCancel(...)`
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
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

/**
 * Structural view of the session's tool executor seam. The gateway is
 * harness-agnostic — it does NOT depend on `@agentick/tool-executor` — so
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
  name: "@agentick/gateway#session",
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
        // 4b — busy-send behavior (steer/queue). A JSON-clean string enum
        // threads straight through; the session owns the semantics.
        ...(params.onBusy !== undefined ? { onBusy: params.onBusy } : {}),
        // Telemetry rung 2 — per-call functionId + metadata. JSON-clean bag,
        // threaded straight through; the session stamps it on every span.
        ...(params.telemetry !== undefined ? { telemetry: params.telemetry } : {}),
        // trail-response-format-send — the declarative `responseFormat`
        // directive. Wire-safe JSON; the wire caller parses the returned
        // `response` text client-side.
        ...(params.responseFormat !== undefined ? { responseFormat: params.responseFormat } : {}),
      });

      // Register cancellation seam — `notifications/cancelled` from
      // the client aborts the underlying execution handle. The
      // dispatcher clears the in-flight entry when the RPC returns.
      ctx.wire.registerCancel(() => {
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
      let completeProgress: (() => void) | undefined;
      if (progressToken !== undefined) {
        const reporter = ctx.wire.progress(progressToken);

        // (1) Execution-event fan-out. Envelope-local counter — separate
        // from the wire's outer `cursor` (managed inside the reporter).
        // Preserves the pre-refactor envelope `id: "progress-N"` shape so
        // downstream consumers keying on `envelope.id` (devtools
        // inspectors, MCP wire codec) don't regress.
        let n = 0;
        const eventDrain = (async () => {
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
        const signalDrain = (async () => {
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

        // End-of-stream marker for this token. It must follow the LAST
        // pushed frame, so it waits on both fan-outs draining — but the RPC
        // response must NOT: the caller's `result` and the caller's event
        // iterator are independent channels, and blocking the response on a
        // detached loop is how a slow tail frame becomes a hung RPC. Hence a
        // detached continuation, armed here and triggered in the `finally`
        // once the signal subscription has been told to stop (which is what
        // lets `signalDrain` resolve at all).
        completeProgress = () => {
          void Promise.all([eventDrain, signalDrain]).then(() => reporter.close());
        };
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
        completeProgress?.();
      }
    },
    "session/dispatch": async ({ sessionId, tool, input }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const content = await sess.tools.dispatch(tool, input as Record<string, unknown>);
      return { content };
    },
    "session/list_tools": async ({ sessionId, exposure }, ctx) => {
      // Dedicated wire read behind the client `ToolsClientHandle` enumeration
      // (three-audiences-plan §F). `session.tools.list` is a sync View read; the
      // handler just projects the query and returns the wire-safe ToolInfo rows.
      // Gateway-resident + harness-agnostic (`tools` is on SessionHarnessProtocol),
      // mirroring session/set_client_tools — the tool executor's `tool:<sessionId>`
      // address does not fit the dynamic-command lane pattern.
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const tools = sess.tools.list(exposure !== undefined ? { exposure } : undefined);
      return { tools };
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
      // by `@agentick/elicitation`. Gateway package intentionally
      // does NOT depend on @agentick/elicitation; cast to the augmented
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
