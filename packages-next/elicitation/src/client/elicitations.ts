/**
 * Client-side elicitation surface — the far side of the
 * `session:channel:elicitation` request channel plus the
 * `session/respond_to_elicitation` reply command.
 *
 * `elicitationStream` opens a session-scoped subscription filtered to
 * elicitation REQUEST envelopes, parses each into a
 * {@link ClientElicitationHandle} (typed `.accept` / `.decline` / `.cancel`),
 * and yields it. `respondToElicitation` is the direct reply for code holding a
 * bare `correlationId` (the handle's `.accept` etc. route through the same
 * wire method).
 *
 * Depends on `@agentick/spec-next` types + `@agentick/utils-next` only — NOT on
 * the elicitation harness runtime, so it stays out of a browser bundle. Mirrors
 * the tasks/knobs `/client` convention. Previously lived in `client-core`'s
 * `handles.ts`; relocated here so client-core stays harness-agnostic (ADR 27 /
 * ADR 87 — the client twin of the server's bundled-not-privileged law).
 *
 * @verifiedBy packages-next/transport-in-process/src/__tests__/elicitation.spec.ts
 */

import type {
  ClientElicitation,
  ClientElicitationHandle,
  ClientElicitationStream,
  ClientProtocol,
  Cursor,
  EventEnvelope,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

import { ELICITATION_CHANNEL_FQN } from "../channel.js";

/** The reply body for a pending elicitation. */
export interface ElicitationReplyInput {
  readonly correlationId: string;
  readonly outcome: "accepted" | "declined" | "cancelled";
  readonly value?: unknown;
  readonly reason?: string;
}

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build a session-scoped subscription filtered to elicitation request
 * envelopes; parse each into a {@link ClientElicitationHandle} and
 * yield. Closing the stream tears down the underlying subscription.
 */
export function elicitationStream(
  client: ClientProtocol,
  sessionId: string,
  fromCursor?: Cursor,
): ClientElicitationStream {
  const sub = client.transport.subscribe(
    { kind: "session", id: sessionId },
    {
      surface: "session",
      name: { exact: ELICITATION_CHANNEL_FQN },
    },
    fromCursor,
  );

  async function* iterator(): AsyncGenerator<ClientElicitationHandle<unknown>> {
    for await (const frame of sub) {
      const env = frame.envelope as EnvelopeWithMetadata;
      // Only request envelopes — responses go on the inbox, not the
      // bus, but a defensive guard keeps us robust if something else
      // ever lands on this channel name.
      if (env.metadata?.requestType !== "request") continue;
      const parsed = parseElicitation(env);
      if (parsed === undefined) continue;
      yield wrapHandle(client, sessionId, parsed);
    }
  }

  const gen = iterator();
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClientElicitationHandle<unknown>> {
      return gen;
    },
    async close(): Promise<void> {
      await sub.close();
    },
  };
}

/**
 * Reply to a pending elicitation by `correlationId` — the direct command for
 * code that does not hold a {@link ClientElicitationHandle}. Routes through
 * `session/respond_to_elicitation` (the handle's `.accept`/`.decline`/`.cancel`
 * use the same path).
 */
export async function respondToElicitation(
  client: ClientProtocol,
  sessionId: string,
  input: ElicitationReplyInput,
): Promise<void> {
  await client.request("session/respond_to_elicitation", {
    sessionId,
    correlationId: input.correlationId,
    outcome: input.outcome,
    ...omitUndefined({ value: input.value, reason: input.reason }),
  });
}

function parseElicitation(env: EnvelopeWithMetadata): ClientElicitation | undefined {
  const correlationId = env.metadata?.correlationId;
  const replyTo = env.metadata?.replyTo;
  if (typeof correlationId !== "string" || typeof replyTo !== "string") return undefined;
  const payload = env.payload as
    | {
        readonly mode?: "form" | "url";
        readonly message?: string;
        readonly schema?: Readonly<Record<string, unknown>>;
        readonly url?: string;
        readonly elicitationId?: string;
        readonly hints?: Readonly<Record<string, unknown>>;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | undefined;
  if (!payload || typeof payload.message !== "string") return undefined;
  return {
    correlationId,
    replyTo,
    mode: payload.mode ?? "form",
    message: payload.message,
    ...omitUndefined({
      schema: payload.schema,
      url: payload.url,
      elicitationId: payload.elicitationId,
      hints: payload.hints,
      metadata: payload.metadata,
    }),
    receivedAt: Date.now(),
  };
}

function wrapHandle(
  client: ClientProtocol,
  sessionId: string,
  elic: ClientElicitation,
): ClientElicitationHandle<unknown> {
  const respond = (body: {
    outcome: "accepted" | "declined" | "cancelled";
    value?: unknown;
    reason?: string;
  }): Promise<void> =>
    respondToElicitation(client, sessionId, { correlationId: elic.correlationId, ...body });
  return {
    ...elic,
    accept(value: unknown): Promise<void> {
      return respond({ outcome: "accepted", value });
    },
    decline(reason?: string): Promise<void> {
      return respond(
        reason !== undefined ? { outcome: "declined", reason } : { outcome: "declined" },
      );
    },
    cancel(reason?: string): Promise<void> {
      return respond(
        reason !== undefined ? { outcome: "cancelled", reason } : { outcome: "cancelled" },
      );
    },
  };
}
