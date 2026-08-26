/**
 * Connector contracts (ADR 58 / ADR 104).
 *
 * A **connector** binds an external event source — a chat platform, a
 * webhook, a message queue, a cron tick — to an agent. Each inbound event
 * becomes an agentic action (a `session.send`, or a one-shot `app.runOnce`);
 * the agent's replies flow back out through `deliver`.
 *
 * A {@link ConnectorSpec} is DATA — a recipe with closures, exactly as a tool
 * declaration carries its handler (`data/tool-handler.ts` precedent).
 * Individual connectors are not harnesses; the machinery that runs them is
 * the gateway's built-in `connectors` harness
 * (`protocol/connectors-harness.ts`), where `inbound` and `deliver` are
 * commands on the op spine.
 *
 * @see docs/proposals/v2/blueprint/104-connectors-as-builtin.md
 */

import type { ContentBlock } from "./content-blocks.js";
import type { MessageSource } from "./message-source.js";
import type { StreamEvent } from "./streaming.js";
import type { Observability } from "./observability.js";
import type { Ops } from "./ops.js";
import type { SendMessageInput, SendInput, SendResult } from "../protocol/session-harness.js";
import type { CreateSessionInput } from "../protocol/app-harness.js";
import type { IngressIdentity } from "../wire/authorizer.js";
import type { GatewayInstallerHost } from "../protocol/app-extension.js";

// ============================================================================
// Inbound
// ============================================================================

/** Session-opening contribution an event may carry (used when it opens the session). */
export type InboundSessionInit = Pick<CreateSessionInput, "metadata" | "initialProps" | "title">;

/** An external event, pushed into the connector via `ctx.inbound(...)`. */
export interface InboundMessage {
  /**
   * The event's messages, in full — the same {@link SendMessageInput} currency
   * `session.send` takes: role, content blocks (an MMS photo as an image
   * block with a `reference` source), per-message metadata. A plain string is
   * shorthand for one user message. The connector adds nothing but
   * {@link source} provenance; everything else is the event's own.
   */
  readonly messages: string | readonly SendMessageInput[];
  /**
   * Route to a specific session (e.g. one per chat/thread/topic). Defaults to
   * the connector's single session ({@link ConnectorSpec.session}).
   */
  readonly sessionId?: string;
  /**
   * Provenance, stamped at `metadata.source` on each message that doesn't
   * already carry one. Typed against the module-augmentable
   * {@link MessageSource} seed.
   */
  readonly source?: MessageSource;
  /**
   * An AUTHENTICATED identity to act as. Present → the session opens through
   * the gateway's `as()` door (ADR 100): authorizer, adopter wire hooks, and
   * the principal stamp run exactly as they would for a transport dispatch.
   * Absent → the trusted local pole, as before. Authenticating is the
   * connector author's job; this field carries the result, never a credential.
   */
  readonly identity?: IngressIdentity;
  /** Merged into `createSession` when this event opens the session. */
  readonly session?: InboundSessionInit;
  /**
   * Per-event send options merged over the default send — structured `output`,
   * `allowedTools`, execution-scoped `tools`, `maxTicks`, …. `messages` is the
   * connector's own and cannot be overridden here.
   */
  readonly send?: Omit<SendInput, "messages">;
  /**
   * Per-event delivery override — route THIS event's result back to its
   * origin (a webhook's reply-to, a classifier's persist). Ephemeral mode
   * only; takes precedence over {@link ConnectorSpec.deliver}.
   */
  readonly deliver?: (delivery: OutboundDelivery) => void | Promise<void>;
}

// ============================================================================
// Outbound
// ============================================================================

/** The agent's output for one completed turn, handed to {@link ConnectorSpec.deliver}. */
export interface OutboundDelivery {
  readonly sessionId: string;
  /** Concatenated assistant text. */
  readonly response: string;
  /** Full assistant content blocks. */
  readonly output: readonly ContentBlock[];
  /**
   * The validated structured output, when the send declared one
   * (`InboundMessage.send.output`). Ephemeral deliveries only — the bus-side
   * path never sees it.
   */
  readonly data?: unknown;
}

/** A confirmation/elicitation the agent wants answered, handed to {@link ConnectorSpec.confirm}. */
export interface ConfirmationPrompt {
  readonly sessionId: string;
  /** Correlation id the reply must echo back via `ctx.confirmed(...)`. */
  readonly correlationId: string;
  /** Human-readable prompt. */
  readonly message: string;
  /** Elicitation mode. `"url"` prompts carry a {@link url}. */
  readonly mode: "form" | "url";
  readonly url?: string;
}

/** The user's reply to a pending confirmation, pushed via `ctx.confirmed(...)`. */
export interface ConfirmationReply {
  readonly correlationId: string;
  /** Raw reply text; parsed to yes/no by the connector. */
  readonly text: string;
}

// ============================================================================
// Streaming
// ============================================================================

/**
 * A live turn, handed to {@link ConnectorSpec.stream} the moment a
 * connector-initiated send starts. Web streams end to end: pipe it wherever
 * bytes go — a TTS sink, a websocket, a platform's edit-as-you-go message.
 *
 * Consume `events` OR `text()`, not both — `text()` is a projection of the
 * same underlying stream (the execution handle's one-consumer rule).
 */
export interface StreamingTurn {
  readonly sessionId: string;
  readonly executionId: string;
  /** Every {@link StreamEvent} of the turn. */
  readonly events: ReadableStream<StreamEvent>;
  /**
   * Just the assistant's text: live `content-delta` chunks when the model
   * streams, whole text blocks when it doesn't — either way, a
   * `ReadableStream<string>` you can pipe.
   */
  text(): ReadableStream<string>;
  /** The turn's final {@link SendResult}. */
  readonly result: Promise<SendResult>;
}

// ============================================================================
// The spec
// ============================================================================

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * What `start` receives: the verbs a source pushes events through, plus the
 * {@link Observability} (`log` / `trace` / `metrics`) and {@link Ops} (`run` /
 * `runner`) facets every tool handler gets (ADR 104) — minted by the
 * connectors harness from real operation context.
 */
export interface ConnectorContext extends Observability, Ops {
  /** An external event arrived. The one required path. */
  inbound(message: InboundMessage): void;
  /**
   * The same door as a {@link WritableStream} — each chunk becomes one
   * inbound event (a bare string is shorthand for `{ messages }`), with
   * `defaults` merged under every chunk. Made for piping:
   *
   * ```ts
   * source.readable.pipeThrough(parse()).pipeTo(ctx.writable({ sessionId }));
   * ```
   */
  writable(defaults?: Partial<InboundMessage>): WritableStream<InboundMessage | string>;
  /** The user answered a pending confirmation. */
  confirmed(reply: ConfirmationReply): void;
  /** Report source health (surfaced via `connectors.status(name)` + a bus event). */
  status(status: ConnectorStatus, error?: Error): void;
  /** Escape hatch: the gateway's host surface (`apps()`, `as()`). */
  readonly gateway: GatewayInstallerHost;
}

/** `start` may return a teardown, `useEffect`-style. */
export type ConnectorTeardown = void | (() => void | Promise<void>);

export interface ConnectorSpec {
  /** Connector name — registry key + diagnostics. Unique per gateway. */
  readonly name: string;
  /**
   * Which hosted app this connector drives. Defaults to the gateway's sole
   * app (resolved lazily — apps may register after the connector starts).
   */
  readonly app?: string;
  /**
   * Default session id when events don't route themselves
   * (`InboundMessage.sessionId`). Defaults to `connector:<name>`.
   */
  readonly session?: string;
  /**
   * Ephemeral mode: each inbound is `app.runOnce` — create, send once,
   * dispose — for one-way processors (classifiers, webhook handlers) that
   * hold no conversation. The run's result goes straight to {@link deliver}
   * when one is defined.
   */
  readonly ephemeral?: boolean;
  /**
   * Begin operation: subscribe your source and push events through
   * `ctx.inbound`. Return a teardown to run at gateway close.
   */
  start(ctx: ConnectorContext): ConnectorTeardown | Promise<ConnectorTeardown>;
  /**
   * OPTIONAL — implement to receive the agent's output for each completed
   * turn. Omit for a one-way ingress connector. Raw hand-off: cadence,
   * chunking, and formatting are yours to compose (`@agentick/formatters`).
   */
  deliver?(delivery: OutboundDelivery): void | Promise<void>;
  /**
   * OPTIONAL — implement to receive each connector-initiated turn LIVE, as
   * web streams ({@link StreamingTurn}). Composes with {@link deliver}:
   * stream for the in-flight experience, deliver for the settled result.
   */
  stream?(turn: StreamingTurn): void | Promise<void>;
  /**
   * OPTIONAL — implement to present confirmations/elicitations to the user;
   * route their answer back via `ctx.confirmed`. Omit to skip confirmation
   * routing entirely.
   */
  confirm?(prompt: ConfirmationPrompt): void | Promise<void>;
}

/**
 * A registered connector as the host sees it — `gateway.connectors.get(name)`.
 * Live view: `status` reads the current value.
 */
export interface ConnectorHandle {
  readonly name: string;
  readonly status: ConnectorStatus;
  /** Last error reported via `ctx.status("error", err)`, if any. */
  readonly error?: Error;
  /**
   * Push a delivery through the connector's `deliver` — the host-initiated
   * outbound path (a scheduled digest, an operator broadcast). Throws for an
   * ingress-only connector (no `deliver` on the spec).
   */
  deliver(delivery: {
    readonly sessionId: string;
    readonly response: string;
    readonly output?: readonly ContentBlock[];
  }): Promise<void>;
}

/** The Config case of the ADR 42 slot trichotomy for `connectors:`. */
export interface ConnectorsConfig {
  readonly connectors: readonly ConnectorSpec[];
}
