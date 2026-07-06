/**
 * `defineConnector` — a connector as ONE server-side `GatewayExtension`
 * composing existing primitives (ADR 58). No new subsystem, no new verb.
 *
 * The base is deliberately small — **it's just a session under the
 * hood.** `install(installer)` wires:
 *
 *   - **inbound (required)**  external event → `installer.gateway.apps()`
 *     → `getSession()/createSession()` → `session.send({ messages })`,
 *     stamping `metadata.source` provenance. The ingress ACTION defaults
 *     to `session.send`; the shape does not preclude `session.dispatch`
 *     or `app.run` later.
 *   - **outbound (optional)**  wired ONLY when the platform implements
 *     `deliver`. On execution completion, hand the agent's raw output to
 *     the platform. No cadence, content-policy, rate-limit, or retry in
 *     the base — those are deferred riders (README Roadmap).
 *   - **confirmations (optional)**  wired ONLY when the platform
 *     implements `presentConfirmation`. Subscribe the elicitation
 *     channel, format the request, route the reply via
 *     `session.elicitation.respond(...)` (in-process; no wire hop).
 *   - **teardown**  `onClose` → unsubscribe + `platform.stop()`.
 *
 * A one-way ingress source (webhook, MQ consumer, cron) implements
 * neither optional half: no subscriptions are opened, inbound-only.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md
 */

import type {
  AppHarnessProtocol,
  GatewayExtension,
  GatewayInstaller,
  ProtocolEvent,
  SendResult,
  SessionHarnessProtocol,
  Unsubscribe,
} from "@agentick/spec-next";
import { extractText } from "@agentick/spec-next";

import { formatConfirmationMessage, parseTextConfirmation } from "./confirmations.js";
import type {
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorConfig,
  ConnectorHandle,
  ConnectorStatus,
  DefineConnectorSpec,
  InboundMessage,
} from "./types.js";

const ELICITATION_EVENT_NAME = "session:channel:elicitation";
const LOOP_EXECUTION_EVENT_NAME = "loop:command:run-execution";

/**
 * The session's elicitation harness surface. Cast at the call site —
 * `@agentick/connector-next` intentionally does NOT depend on
 * `@agentick/elicitation-next` at runtime (it constructs no harness;
 * the AppHarness owns construction, #159). Identical discipline to the
 * gateway's `session/respondToElicitation` wire method
 * (`gateway/src/wire/session-extension.ts`).
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

export function defineConnector(spec: DefineConnectorSpec): GatewayExtension {
  const { name, platform } = spec;
  const config: ConnectorConfig = spec.config ?? {};
  const defaultSessionId = config.sessionId ?? `connector:${name}`;

  return {
    name: `@agentick/connector:${name}`,
    target: "gateway",
    async install(installer: GatewayInstaller): Promise<void> {
      let currentStatus: ConnectorStatus = "connecting";

      // Sessions this connector bridges. Outbound + confirmation events
      // for other sessions on the shared gateway bus are ignored.
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
        if (config.appId) {
          const app = apps.find((a) => a.id === config.appId);
          if (!app) {
            throw new Error(`connector "${name}": no app "${config.appId}" on the gateway`);
          }
          return app;
        }
        if (apps.length === 0) {
          throw new Error(`connector "${name}": no app available on the gateway`);
        }
        return apps[0]!;
      }

      async function resolveSession(sessionId: string): Promise<SessionHarnessProtocol> {
        const app = resolveApp();
        return app.getSession(sessionId) ?? (await app.createSession({ sessionId }));
      }

      // ── inbound (required): event → session.send ──

      async function handleInbound(msg: InboundMessage): Promise<void> {
        // Allowlist gate (a whitelist, not identity — ADR 58).
        if (config.allowlist) {
          if (msg.senderId === undefined || !config.allowlist.includes(msg.senderId)) {
            return; // dropped
          }
        }

        const sessionId = msg.sessionId ?? defaultSessionId;
        const session = await resolveSession(sessionId);
        managedSessions.add(session.id);

        const metadata = msg.source !== undefined ? { source: msg.source } : undefined;
        // TODO(#302: per-message actor stamping) — attribute to the platform
        // actor (RuntimeContextUser) once interceptIngress lands (ADR 34/#302);
        // today attributes to the connector's service-account principal.
        //
        // The ingress ACTION is `session.send` by default. The seam is
        // intentionally open — a future config could route an event to
        // `session.dispatch(tool, input)` or `app.run(...)` instead.
        await session.send({
          messages: [{ role: "user", content: msg.text, ...(metadata ? { metadata } : {}) }],
        });
      }

      // ── outbound (optional): hand raw output to the platform ──

      const subscriptions: Unsubscribe[] = [];

      if (platform.deliver) {
        const deliver = platform.deliver.bind(platform);
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
              // `SendResult.response` is assembled by the session-send
              // wrapper and is absent on the raw loop-terminal envelope, so
              // derive the concatenated text from `output` (the field that
              // IS present) — accurate regardless of who assembled the result.
              const response = result.response ?? extractText(result.output);
              void Promise.resolve(
                deliver({ sessionId: sid, response, output: result.output }),
              ).catch(reportError);
            },
          ),
        );
      }

      // ── confirmations (optional): elicitation channel → platform ──

      async function handleConfirmationReply(reply: ConfirmationReply): Promise<void> {
        const entry = pendingConfirmations.get(reply.correlationId);
        if (!entry) return; // unknown or already resolved
        pendingConfirmations.delete(reply.correlationId);
        const session = resolveApp().getSession(entry.sessionId);
        if (!session) return;
        // A text reply ANSWERS a yes/no confirmation: "yes" → accepted(true),
        // "no" → accepted(false) (v1 `ToolConfirmationResponse.approved`
        // parity). `declined` / `cancelled` model an explicit dismissal,
        // which a text reply is not.
        const decision = parseTextConfirmation(reply.text);
        const elic = session as SessionWithElicitation;
        await elic.elicitation.respond({
          correlationId: reply.correlationId,
          outcome: "accepted",
          value: decision.approved,
          reason: decision.reason,
        });
      }

      if (platform.presentConfirmation) {
        const present = platform.presentConfirmation.bind(platform);
        subscriptions.push(
          installer.subscribeBus({ name: { exact: ELICITATION_EVENT_NAME } }, (event) => {
            const sid = event.scope?.sessionId;
            if (!sid || !managedSessions.has(sid)) return;
            // `request()` envelopes carry correlationId in a `metadata`
            // sidecar the base harness stamps at publish time
            // (base-harness.ts) — not on the typed `EventEnvelope`, so read
            // it through a cast. Observed wire shape.
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

      // ── platform handle ──

      const handle: ConnectorHandle = {
        emitInbound: (msg) => void handleInbound(msg).catch(reportError),
        respondConfirmation: (reply) => void handleConfirmationReply(reply).catch(reportError),
        reportStatus: (status, error) => {
          currentStatus = status;
          if (status === "error" && error) reportError(error);
        },
      };

      await platform.start(handle);
      currentStatus = platform.status ?? "connected";
      void currentStatus; // reserved for a future status-projection surface

      installer.onClose(async () => {
        for (const unsub of subscriptions) unsub();
        pendingConfirmations.clear();
        await platform.stop();
      });
    },
  };
}
