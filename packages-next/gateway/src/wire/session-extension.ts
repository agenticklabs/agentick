/**
 * `sessionWireExtension` — framework-supplied `WireExtension` that
 * projects the `session/*` namespace over the Agentick client↔gateway
 * wire (partial — the streaming methods stay hardcoded pending #303).
 *
 * Part of the ADR 46 eat-our-own-dogfood commitment (#295 Phase C).
 * Deferred to #303 (streaming primitives on `WireExtensionContext`):
 *
 *   - `session/send` — needs `sink.sendNotification` for progress
 *     frames + `sink.registerInFlight` for cancellation
 *   - `subscribe` / `unsubscribe` — needs sink for subscription
 *     event fan-out; also awaiting #300 rename to
 *     `sub/subscribe` / `sub/unsubscribe`
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
    "session/dispatch": async ({ sessionId, tool, input }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const content = await sess.dispatch(tool, input as Record<string, unknown>);
      return { content };
    },
    "session/abort": async ({ sessionId }, ctx) => {
      // Stub-only today: SessionHarnessProtocol exposes abort() on the
      // returned SessionExecutionHandle, not on the session itself.
      // Full wiring requires per-session active-handle tracking on the
      // transport server adapter — deferred to #303 alongside
      // session/send streaming primitives.
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
