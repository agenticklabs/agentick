/**
 * `fakeConnectorPlatform` — a Meszaros **fake** {@link ConnectorPlatform}.
 *
 * A working in-memory platform for tests: it records outbound
 * deliveries + confirmation prompts, and exposes drivers that let a test
 * emit inbound events and answer confirmations. Naming per the
 * test-double convention (`fake*` = working impl).
 *
 * By default it implements the optional `deliver` + `presentConfirmation`
 * halves. Pass `{ oneWay: true }` for an ingress-only source (no
 * `deliver`, no `presentConfirmation`) to exercise the one-way path.
 */

import type {
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorHandle,
  ConnectorPlatform,
  ConnectorStatus,
  InboundMessage,
  OutboundDelivery,
} from "../types.js";

export interface FakeConnectorPlatform extends ConnectorPlatform {
  /** All deliveries the connector pushed to this platform, in order. */
  readonly delivered: OutboundDelivery[];
  /** All confirmation prompts the connector presented, in order. */
  readonly confirmations: ConfirmationPrompt[];
  /** True once the connector has called `start()`. */
  readonly started: boolean;
  /** True once the connector has called `stop()`. */
  readonly stopped: boolean;
  readonly status: ConnectorStatus;

  // ── drivers (test → connector) ──
  /** Simulate an inbound event. Throws if not started. */
  emit(message: InboundMessage): void;
  /** Simulate the user answering a pending confirmation. */
  reply(reply: ConfirmationReply): void;
  /** Convenience: answer the most-recent confirmation prompt. */
  replyLatest(text: string): void;
  /** Report a platform status change up to the connector. */
  report(status: ConnectorStatus, error?: Error): void;
}

export interface FakeConnectorPlatformOptions {
  readonly name?: string;
  /**
   * When true, produce an ingress-only platform: no `deliver`, no
   * `presentConfirmation`. Exercises the one-way connector path.
   */
  readonly oneWay?: boolean;
}

export function fakeConnectorPlatform(
  options: FakeConnectorPlatformOptions = {},
): FakeConnectorPlatform {
  const delivered: OutboundDelivery[] = [];
  const confirmations: ConfirmationPrompt[] = [];
  let handle: ConnectorHandle | undefined;
  let started = false;
  let stopped = false;
  let status: ConnectorStatus = "disconnected";

  const platform: FakeConnectorPlatform = {
    name: options.name ?? "fake",
    get delivered() {
      return delivered;
    },
    get confirmations() {
      return confirmations;
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get status() {
      return status;
    },

    start(h: ConnectorHandle) {
      handle = h;
      started = true;
      status = "connected";
    },
    stop() {
      stopped = true;
      status = "disconnected";
    },
    // Optional halves — present unless `oneWay`.
    ...(options.oneWay
      ? {}
      : {
          deliver(delivery: OutboundDelivery) {
            delivered.push(delivery);
          },
          presentConfirmation(prompt: ConfirmationPrompt) {
            confirmations.push(prompt);
          },
        }),

    emit(message: InboundMessage) {
      if (!handle) throw new Error("fake platform: emit() before start()");
      handle.emitInbound(message);
    },
    reply(reply: ConfirmationReply) {
      if (!handle) throw new Error("fake platform: reply() before start()");
      handle.respondConfirmation(reply);
    },
    replyLatest(text: string) {
      const latest = confirmations.at(-1);
      if (!latest) throw new Error("fake platform: no pending confirmation to reply to");
      platform.reply({ correlationId: latest.correlationId, text });
    },
    report(next: ConnectorStatus, error?: Error) {
      if (!handle) throw new Error("fake platform: report() before start()");
      handle.reportStatus(next, error);
    },
  };

  return platform;
}
