/**
 * `defineConnector` — one flat spec becomes one `GatewayExtension`.
 *
 * `install(installer)` wires:
 *
 *   - **inbound (required)** — `spec.start(ctx)` subscribes the source;
 *     each `ctx.inbound(msg)` becomes `session.send` (or `app.runOnce` in
 *     ephemeral mode), opened through the gateway's `as()` door when the
 *     event carries an authenticated identity.
 *   - **outbound (optional)** — wired only when `spec.deliver` exists: each
 *     completed turn on a connector-held session hands the raw output over.
 *   - **confirmations (optional)** — wired only when `spec.confirm` exists:
 *     elicitation requests are formatted and presented; replies route back
 *     via `session.elicitation.respond` (in-process, no wire hop).
 *   - **teardown** — `onClose` → unsubscribe, then `start`'s returned
 *     teardown, `useEffect`-style.
 *
 * @see README.md
 */

import type {
  AppHarnessProtocol,
  GatewayExtension,
  GatewayInstaller,
  ProtocolEvent,
  SendResult,
  SessionHarnessProtocol,
  Unsubscribe,
} from "@agentick/spec";
import { extractText } from "@agentick/spec";

import { formatConfirmationMessage, parseTextConfirmation } from "./confirmations.js";
import type {
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorContext,
  ConnectorSpec,
  ConnectorStatus,
  ConnectorTeardown,
  InboundMessage,
  StreamingTurn,
} from "./types.js";
import { textStream } from "./text-stream.js";

const ELICITATION_EVENT_NAME = "session:channel:elicitation";
const LOOP_EXECUTION_EVENT_NAME = "loop:command:run-execution";

/**
 * The session's elicitation surface, cast at the call site —
 * `@agentick/connector` deliberately holds no runtime dependency on
 * `@agentick/elicitation` (the AppHarness owns construction, #159). Same
 * discipline as the gateway's `session/respond_to_elicitation` wire method.
 */
type SessionWithElicitation = SessionHarnessProtocol & {
  readonly elicitation: {
    respond(input: {
      readonly correlationId: string;
      readonly outcome: "accepted" | "declined" | "cancelled";
      readonly value?: unknown;
      readonly reason?: string;
    }): Promise<void>;
  };
};

export function defineConnector(spec: ConnectorSpec): GatewayExtension {
  const { name } = spec;
  const defaultSessionId = spec.session ?? `connector:${name}`;

  return {
    name: `@agentick/connector:${name}`,
    target: "gateway",
    async install(installer: GatewayInstaller): Promise<void> {
      let currentStatus: ConnectorStatus = "connecting";

      // Sessions this connector holds; other sessions' bus events are ignored.
      const managedSessions = new Set<string>();
      // correlationId → sessionId for in-flight confirmations.
      const pendingConfirmations = new Map<string, { readonly sessionId: string }>();

      function reportError(err: unknown): void {
        // eslint-disable-next-line no-console
        console.error(`connector "${name}":`, err);
      }

      // ── app / session resolution (lazy — apps may not exist yet) ──

      function resolveApp(): AppHarnessProtocol {
        const apps = installer.gateway.apps();
        if (spec.app) {
          const app = apps.find((a) => a.id === spec.app);
          if (!app) {
            throw new Error(`connector "${name}": no app "${spec.app}" on the gateway`);
          }
          return app;
        }
        if (apps.length === 0) {
          throw new Error(`connector "${name}": no app available on the gateway`);
        }
        return apps[0]!;
      }

      /**
       * The app door for one inbound event. An authenticated identity routes
       * through the gateway's ADR 100 `as()` seam — authorizer, adopter
       * `onBeforeWire…` hooks, principal stamp, exactly as a transport
       * dispatch — landing on the LOCAL harness; without one, the trusted
       * local pole, as before.
       */
      function resolveDoor(msg: InboundMessage): {
        createSession(
          init: Parameters<AppHarnessProtocol["createSession"]>[0],
        ): Promise<SessionHarnessProtocol>;
        runOnce: AppHarnessProtocol["runOnce"];
        getSession(sessionId: string): SessionHarnessProtocol | undefined;
      } {
        const app = resolveApp();
        if (msg.identity === undefined) {
          return {
            createSession: (init) => app.createSession(init),
            runOnce: (input) => app.runOnce(input),
            getSession: (sessionId) => app.getSession(sessionId),
          };
        }
        const scoped = installer.gateway.as(msg.identity).app(app.id);
        if (!scoped) {
          throw new Error(`connector "${name}": app "${app.id}" not resolvable through as()`);
        }
        return {
          createSession: (init) => scoped.createSession(init),
          runOnce: (input) => scoped.runOnce(input),
          // The identity door has no session-read verb; create-or-resume
          // covers the identity path.
          getSession: () => undefined,
        };
      }

      // ── inbound (required): event → session.send | app.runOnce ──

      async function handleInbound(msg: InboundMessage): Promise<void> {
        // Allowlist gate (a whitelist, not identity — ADR 58).
        if (spec.allowlist) {
          if (msg.senderId === undefined || !spec.allowlist.includes(msg.senderId)) {
            return; // dropped
          }
        }

        const metadata = msg.source !== undefined ? { source: msg.source } : undefined;
        const message = {
          role: "user" as const,
          content: msg.text,
          ...(metadata ? { metadata } : {}),
        };
        const door = resolveDoor(msg);

        if (spec.ephemeral) {
          const { result, sessionId } = await door.runOnce({
            send: { ...msg.send, messages: [message] },
            ...(msg.session?.metadata !== undefined ? { metadata: msg.session.metadata } : {}),
          });
          // No held session to watch on the bus — hand the result off directly.
          if (spec.deliver && result.output.length > 0) {
            await spec.deliver({ sessionId, response: result.response, output: result.output });
          }
          return;
        }

        const sessionId = msg.sessionId ?? defaultSessionId;
        const session =
          door.getSession(sessionId) ?? (await door.createSession({ sessionId, ...msg.session }));
        managedSessions.add(session.id);

        // TODO(#302: per-message actor stamping) — interceptIngress will carry
        // the platform actor per message; `msg.identity` covers the
        // session-opening half today.
        const handle = await session.send({
          ...(spec.stream ? { stream: true } : {}),
          ...msg.send,
          messages: [message],
        });

        if (spec.stream) {
          const events = handle.readable();
          const turn: StreamingTurn = {
            sessionId: session.id,
            executionId: handle.executionId,
            events,
            text: () => textStream(events),
            result: handle.result,
          };
          void Promise.resolve(spec.stream(turn)).catch(reportError);
        }
      }

      // ── outbound (optional): hand raw output to the source ──

      const subscriptions: Unsubscribe[] = [];

      if (spec.deliver) {
        const deliver = spec.deliver.bind(spec);
        const extractSendResult = (event: ProtocolEvent): SendResult | undefined => {
          const payload = event.payload as
            | { result?: { outcome?: string; result?: SendResult } }
            | undefined;
          const outcome = payload?.result;
          if (!outcome || outcome.outcome !== "succeeded" || !outcome.result) return undefined;
          return outcome.result;
        };

        subscriptions.push(
          installer.subscribeBus(
            { surface: "loop", name: { exact: LOOP_EXECUTION_EVENT_NAME }, phase: "terminal" },
            (event) => {
              const sid = event.scope?.sessionId;
              if (!sid || !managedSessions.has(sid)) return;
              const result = extractSendResult(event);
              if (!result || result.output.length === 0) return;
              // `SendResult.response` is assembled by the session-send wrapper
              // and is absent on the raw loop-terminal envelope — derive from
              // `output` (the field that IS present).
              const response = result.response ?? extractText(result.output);
              void Promise.resolve(
                deliver({ sessionId: sid, response, output: result.output }),
              ).catch(reportError);
            },
          ),
        );
      }

      // ── confirmations (optional): elicitation channel → source ──

      async function handleConfirmationReply(reply: ConfirmationReply): Promise<void> {
        const entry = pendingConfirmations.get(reply.correlationId);
        if (!entry) return; // unknown or already resolved
        pendingConfirmations.delete(reply.correlationId);
        const session = resolveApp().getSession(entry.sessionId);
        if (!session) return;
        // A text reply ANSWERS a yes/no confirmation: "yes" → accepted(true),
        // "no" → accepted(false). `declined`/`cancelled` model an explicit
        // dismissal, which a text reply is not.
        const decision = parseTextConfirmation(reply.text);
        const elic = session as SessionWithElicitation;
        await elic.elicitation.respond({
          correlationId: reply.correlationId,
          outcome: "accepted",
          value: decision.approved,
          reason: decision.reason,
        });
      }

      if (spec.confirm) {
        const present = spec.confirm.bind(spec);
        subscriptions.push(
          installer.subscribeBus({ name: { exact: ELICITATION_EVENT_NAME } }, (event) => {
            const sid = event.scope?.sessionId;
            if (!sid || !managedSessions.has(sid)) return;
            // `request()` envelopes carry correlationId in a `metadata`
            // sidecar the base harness stamps at publish time — not on the
            // typed `EventEnvelope`. Observed wire shape.
            const meta = (event as { metadata?: { correlationId?: string; requestType?: string } })
              .metadata;
            if (meta?.requestType !== "request" || !meta.correlationId) return;
            const payload = event.payload as
              | { mode?: "form" | "url"; message?: string; url?: string }
              | undefined;
            if (!payload) return;
            const correlationId = meta.correlationId;
            pendingConfirmations.set(correlationId, { sessionId: sid });
            const prompt: ConfirmationPrompt = {
              sessionId: sid,
              correlationId,
              message: formatConfirmationMessage({
                message: payload.message ?? "Confirm?",
                ...(payload.url ? { url: payload.url } : {}),
              }),
              mode: payload.mode ?? "form",
              ...(payload.url ? { url: payload.url } : {}),
            };
            void Promise.resolve(present(prompt)).catch(reportError);
          }),
        );
      }

      // ── start the source ──

      const ctx: ConnectorContext = {
        inbound: (msg) => void handleInbound(msg).catch(reportError),
        writable: (defaults = {}) =>
          new WritableStream<InboundMessage | string>({
            write: (chunk) =>
              handleInbound(
                typeof chunk === "string"
                  ? { ...defaults, text: chunk }
                  : { ...defaults, ...chunk },
              ),
          }),
        confirmed: (reply) => void handleConfirmationReply(reply).catch(reportError),
        status: (status, error) => {
          currentStatus = status;
          if (status === "error" && error) reportError(error);
        },
        gateway: installer.gateway,
      };

      const teardown: ConnectorTeardown = await spec.start(ctx);
      if (currentStatus === "connecting") currentStatus = "connected";
      void currentStatus; // reserved for a future status-projection surface

      installer.onClose(async () => {
        for (const unsub of subscriptions) unsub();
        pendingConfirmations.clear();
        if (typeof teardown === "function") await teardown();
      });
    },
  };
}
