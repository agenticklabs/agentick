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
  SessionNotFoundError,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

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
      });

      // Register cancellation seam — `notifications/cancelled` from
      // the client aborts the underlying execution handle. The
      // dispatcher clears the in-flight entry when the RPC returns.
      ctx.transport.registerCancel(() => {
        void handle.abort("client cancelled");
      });

      // LSP-style progress: opt-in via `_meta.progressToken`. When
      // set, drain the handle's AsyncIterable in the background and
      // fan out one `notifications/progress` frame per event.
      if (progressToken !== undefined) {
        const reporter = ctx.transport.progress(progressToken);
        // Envelope-local counter — separate from the wire's outer
        // `cursor` (which the framework manages inside the reporter).
        // Preserves the pre-refactor envelope `id: "progress-N"`
        // shape so downstream consumers that key on `envelope.id`
        // (devtools inspectors, MCP wire codec) don't regress.
        let n = 0;
        (async () => {
          try {
            for await (const event of handle) {
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
      }

      const result = await handle.result;
      return {
        executionId: handle.executionId,
        finalCursor: { value: 0 },
        result,
      };
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
    "session/respondToElicitation": async (params, ctx) => {
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
  },
});
