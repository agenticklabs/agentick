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
  findSession,
  findSessionOrResume,
  findSessionOwner,
  progressEventQuery,
  resolveSessionDoor,
  toClientToolRegistration,
  type AppHarnessProtocol,
  type ProtocolEvent,
  type SessionHarnessProtocol,
  type ToolExecutorProtocol,
  type WireExtension,
} from "@agentick/spec";
import { omitUndefined, paginate } from "@agentick/utils";

import { fanOutProgressSignals } from "./progress-fanout.js";
import { toSessionEntry, visibleTo } from "./session-list.js";

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

/**
 * Does this signal envelope belong to the turn rooted at `executionId`?
 *
 * The whole of `fanIn` — no router, no subscription manager, just the
 * predicate a gateway-wide subscription is filtered through. Two admissions,
 * and they are the two halves of "this turn":
 *
 *   1. The turn's OWN work — the envelope's execution IS the target. This is
 *      the default subscription's bus-side filter, restated on the arrival
 *      side because the subscription is no longer filtered.
 *   2. The turn's DESCENDANTS — the emitting session's lineage reaches the
 *      target execution ({@link AppHarnessProtocol.executionTreeContains}, an
 *      O(depth) registry walk). Their signals carry their own execution ids,
 *      so (1) can never see them.
 *
 * Everything else is refused, which is the isolation guarantee stated
 * positively: a sibling execution — on this session or any other — satisfies
 * neither arm, and neither do its descendants, because their lineage reaches
 * the sibling's execution, not this one.
 *
 * The `appId` check addresses the one seam a gateway-wide subscription opens.
 * Session ids are unique within an app, not across apps on one gateway, so a
 * foreign app's session sharing an id with a descendant of this turn would
 * otherwise be admitted by (2) — the lineage walk reads THIS app's registry and
 * would find OUR session under that id. Execution ids are ULIDs and do not
 * collide, so (1) needs no such guard.
 *
 * TODO(signal-scope-app-id): the check is currently inert in the default
 * deployment. A signal envelope's scope is gap-filled from the emitting
 * harness's `parentScope`, which the app stamps as `{ sessionId }` only — no
 * `appId` reaches a `tool:signal:progress` envelope, so the guard has nothing
 * to compare and lineage decides alone. The narrow hole that leaves: two apps
 * on ONE gateway, both given the SAME explicit session id by the adopter (spawn
 * generates ULIDs, so this needs deliberate id reuse), with concurrent fanIn
 * turns. Closing it belongs at the emitter — `appId` on the per-session
 * `parentScope` — not here, because every scope-filtered subscriber on the bus
 * has the same blind spot, not just this one.
 */
function inThisTurn(
  envelope: ProtocolEvent,
  executionId: string,
  app: AppHarnessProtocol | undefined,
): boolean {
  if (envelope.scope.executionId === executionId) return true;
  if (app === undefined) return false;
  if (envelope.scope.appId !== undefined && envelope.scope.appId !== app.id) return false;
  const sessionId = envelope.scope.sessionId;
  return sessionId !== undefined && app.executionTreeContains(executionId, sessionId);
}

export const sessionWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/gateway#session",
  namespace: "session",
  version: "1.0.0",
  methods: {
    // The ONE existence-creating verb (session-doors.md §3): a send names the
    // conversation it is about, so it resolves through all three doors — live,
    // resume (the reaper paged it out; a 404 would make eviction look like data
    // loss), create (the client minted the id and this is the first message).
    // Reads never create; sends never 404.
    //
    // TODO(resume-ctx-app): `ctx.app` is resolved by the dispatcher's LIVE walk,
    // so it is undefined for the send that did the remounting — `fanIn` loses
    // descendant progress frames for that one turn, then behaves normally.
    "session/send": async (params, ctx) => {
      // Creation stamps the caller's principal from the authenticated identity,
      // exactly as `app/create_session` does — the params carry no `principal`
      // slot, so ownership is never the caller's to claim.
      const { session: sess, door } = ctx.session
        ? { session: ctx.session, door: "live" as const }
        : await resolveSessionDoor(
            ctx,
            params.sessionId,
            omitUndefined({ appId: params.appId, principal: ctx.principal }),
          );
      const progressToken = params._meta?.progressToken;

      const handle = await sess.send({
        // The asking connection, straight off the wire ctx — the one fact a
        // session cannot derive and the tool relay later needs.
        ...(ctx.connectionId !== undefined ? { connectionId: ctx.connectionId } : {}),
        ...(ctx.clientId !== undefined ? { clientId: ctx.clientId } : {}),
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
        // `ctx.progress(...)`. Push the raw signal envelope (self-describing:
        // `name` is `<surface>:signal:progress`, `payload` is the
        // ProgressEventPayload, `scope` names the emitting session +
        // execution) so the client can discriminate it from execution events
        // and attribute it. Torn down when the send settles — the gateway bus
        // outlives this RPC, so the subscription must be explicitly stopped.
        //
        // SCOPE, and the one knob on it. By default the subscription is
        // filtered at the bus to this execution: concurrent executions on the
        // same session never cross-contaminate, and a sub-agent — running its
        // OWN execution — is out of view. `fanIn` trades that narrow filter for
        // a gateway-wide subscription plus `inThisTurn` below, which is the
        // same isolation rule widened by exactly one axis: lineage.
        //
        // Signals only. Execution EVENTS keep producer (1)'s scope untouched —
        // what a child surfaces to its parent's event stream is already
        // decided at the harness level (`TickEndForwardDecision`), and a second
        // answer to that question at the wire would be a competing one.
        //
        // The OTHER client observation channel — `sub/subscribe` over
        // `session:channel:*` — had the same blind spot and now has its own
        // answer: the `session-tree` subscription scope, same pair (widen the
        // subscription, filter on arrival) with the membership question a
        // subscription actually asks. A subscription outlives any one turn, so
        // it keys on the SESSION subtree (`app.sessionTreeContains`, lineage)
        // where this keys on the EXECUTION tree (`executionTreeContains`, one
        // turn). Turn interiors here; living subtree there.
        const fanIn = params.fanIn === true;
        const signals = fanOutProgressSignals(
          (q) => ctx.gateway.events(q),
          reporter,
          fanIn
            ? progressEventQuery()
            : { ...progressEventQuery(), scope: { executionId: handle.executionId } },
          fanIn ? (e) => inThisTurn(e, handle.executionId, ctx.app) : undefined,
        );
        stopSignalDrain = signals.stop;

        // End-of-stream marker for this token. It must follow the LAST
        // pushed frame, so it waits on both fan-outs draining — but the RPC
        // response must NOT: the caller's `result` and the caller's event
        // iterator are independent channels, and blocking the response on a
        // detached loop is how a slow tail frame becomes a hung RPC. Hence a
        // detached continuation, armed here and triggered in the `finally`
        // once the signal subscription has been told to stop (which is what
        // lets `signalDrain` resolve at all).
        completeProgress = () => {
          void Promise.all([eventDrain, signals.drained]).then(() => reporter.close());
        };
      }

      try {
        const result = await handle.result;
        return {
          executionId: handle.executionId,
          finalCursor: { value: 0 },
          result,
          door,
        };
      } finally {
        // Stop the signal drain regardless of success/failure so the
        // background subscription doesn't outlive the RPC.
        stopSignalDrain?.();
        completeProgress?.();
      }
    },
    // The PURE read (session-doors.md §2) — the durable record and nothing
    // else: no live walk, no resume, no create, so a client can render a thread
    // header for a session the reaper collected without paying to rebuild it.
    // `null`, not a throw: "no such record" is the answer a client renders a
    // local draft on. An invisible record answers the same way a list hides one
    // — a 403 here would confirm the id exists.
    "session/get": async ({ sessionId }, ctx) => {
      for (const app of ctx.gateway.apps()) {
        const record = await app.getSessionRecord(sessionId);
        if (record !== undefined && visibleTo(record, ctx.principal)) return toSessionEntry(record);
      }
      return null;
    },
    // Compile what a tick WOULD send, without sending it. The whole prompt is
    // in the response, which is why it is same-principal only — `findSession`
    // resolves through the gateway's own ownership rules, the same as every
    // other session verb.
    //
    // `request` (the provider-native rung) is dropped: it is adapter-shaped and
    // not guaranteed JSON-clean, and a client that wants it should ask the
    // server that holds the adapter. The two rungs a client can act on — the IR
    // and the model input — cross intact.
    "session/dry_run": async ({ sessionId }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const { tree, input } = await sess.dryRun();
      return { tree, input };
    },
    "session/compile": async ({ sessionId }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      return { tree: await sess.compile() };
    },
    "session/project": async ({ sessionId }, ctx) => {
      const sess = ctx.session ?? findSession(ctx, sessionId);
      return { input: await sess.project() };
    },
    // Remounts like `session/send` does, and for the same reason: dispatching a
    // tool is work asked of the session, not an observation of it.
    "session/dispatch": async ({ sessionId, tool, input }, ctx) => {
      const sess = ctx.session ?? (await findSessionOrResume(ctx, sessionId));
      const content = await sess.tools.dispatch(tool, input as Record<string, unknown>);
      return { content };
    },
    "session/list_tools": async ({ sessionId, exposure, cursor }, ctx) => {
      // Dedicated wire read behind the client `ToolsClientHandle` enumeration
      // (three-audiences-plan §F). `session.tools.list` is a sync View read; the
      // handler just projects the query and returns the wire-safe ToolInfo rows.
      // Gateway-resident + harness-agnostic (`tools` is on SessionHarnessProtocol),
      // mirroring session/set_client_tools — the tool executor's `tool:<sessionId>`
      // address does not fit the dynamic-command lane pattern.
      //
      // Paged on the WIRE only, over the snapshot the sync read already serves,
      // with the shared `paginate` every catalog surface uses.
      const sess = ctx.session ?? findSession(ctx, sessionId);
      const all = sess.tools.list(exposure !== undefined ? { exposure } : undefined);
      const { page, nextCursor } = paginate(all, cursor);
      return { tools: page, ...omitUndefined({ nextCursor }) };
    },
    "session/model_info": async ({ sessionId }, ctx) => {
      // The session's LIVE target, not the app's default: a runtime swap
      // (`session:set-model`, a spawn override) is invisible to the app-scoped
      // catalog lookup until the next turn stamps its provenance.
      return (ctx.session ?? findSession(ctx, sessionId)).modelInfo() ?? null;
    },
    "session/abort": async ({ sessionId, reason, cascade }, ctx) => {
      // The STANDALONE cancellation verb — reaches a session by id, with no
      // in-flight RPC to correlate against. (`notifications/cancelled` is the
      // other cancellation path: it aborts the execution behind a specific
      // in-flight `session/send`, via the cancel callback that handler
      // registers. A caller holding only a sessionId — a second connection, a
      // supervisor, a UI that reconnected — has this one.)
      //
      // `session.abort` targets the session's CURRENT execution and no-ops on
      // an idle session, so a race with a naturally-finishing execution is a
      // success, not an error.
      //
      // `cascade` widens the SCOPE to the session's live spawn subtree — the
      // remote twin of `abort({ cascade: true })`, threaded through untouched.
      // Absent ⇒ the verb behaves exactly as it did before cascade existed. It
      // needs no gate of its own: the subtree is this session's own descendants
      // (principal descends the spawn tree), so the same-principal check the
      // dispatch gate already made on `sessionId` covers every session reached.
      const sess = ctx.session ?? findSession(ctx, sessionId);
      await sess.abort(reason, cascade === true ? { cascade: true } : undefined);
      return null;
    },
    // Through the OWNING APP, not `sess.close()`: closing the harness directly
    // ends the session but leaves the app's live registry holding it, so the
    // next `create_session` with that id hands back the dead one. One door for
    // teardown — `ctx.session` is deliberately not used, since the app is the
    // half of the pair this verb needs.
    "session/close": async ({ sessionId }, ctx) => {
      await findSessionOwner(ctx, sessionId).app.closeSession(sessionId);
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
      // UPSERT by name, latest declaration wins. NOT a whole-slice replace:
      // several clients share this session's slice, and clearing it before
      // reinstalling meant the second client to declare silently deleted the
      // first one's tools — the model stopped seeing them, and the client that
      // lost them had asked for nothing.
      //
      // Each declaration folds into a CLIENT-HANDLED registration via
      // `toClientToolRegistration` (raw JSON-Schema `inputSchema` wrapped into a
      // validator; `handlerRef` omitted ⇒ client-handled). Session-lifetime:
      // the session-close cleanup reaps the whole slice.
      //
      // The cost of dropping the clear is that a departed client's tools linger
      // until the session closes. A call to one answers with its
      // `defaultResult` on timeout, which is what a call to any absent client
      // already does — so it is a known shape, not a new failure.
      for (const declaration of params.declarations) {
        const registration = toClientToolRegistration(declaration, binding);
        await sess.toolExecutor.register({ registration, replace: true });
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
