/**
 * `connectorProbe()` — a test double for the SOURCE side of a connector.
 *
 * Spread `probe.spec` into `defineConnector({ name, ...probe.spec })`: `start`
 * captures the {@link ConnectorContext}, `deliver`/`confirm` record what the
 * connector hands back, and the drivers (`emit`, `reply`) push events in as a
 * real source would.
 *
 * `oneWay: true` produces an ingress-only spec (no `deliver`, no `confirm`) to
 * exercise the base path where no bus subscriptions open at all.
 */

import type {
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorContext,
  ConnectorSpec,
  InboundMessage,
  OutboundDelivery,
} from "../types.js";

export interface ConnectorProbe {
  /** Spread into `defineConnector({ name, ...probe.spec })`. */
  readonly spec: Pick<ConnectorSpec, "start" | "deliver" | "confirm">;
  /** All deliveries the connector pushed, in order. */
  readonly delivered: OutboundDelivery[];
  /** All confirmation prompts the connector presented, in order. */
  readonly prompts: ConfirmationPrompt[];
  /** Push an inbound event, as the source would. */
  emit(message: InboundMessage): void;
  /** Answer a pending confirmation, as the user would. */
  reply(reply: ConfirmationReply): void;
  /** Whether the teardown returned from `start` has run. */
  readonly stopped: boolean;
}

export function connectorProbe(options: { readonly oneWay?: boolean } = {}): ConnectorProbe {
  let ctx: ConnectorContext | undefined;
  const delivered: OutboundDelivery[] = [];
  const prompts: ConfirmationPrompt[] = [];
  let stopped = false;

  const require = (): ConnectorContext => {
    if (!ctx) throw new Error("connectorProbe: not started — install the connector first");
    return ctx;
  };

  const spec: Pick<ConnectorSpec, "start" | "deliver" | "confirm"> = {
    start(context) {
      ctx = context;
      return () => {
        stopped = true;
      };
    },
    ...(options.oneWay
      ? {}
      : {
          deliver(delivery: OutboundDelivery) {
            delivered.push(delivery);
          },
          confirm(prompt: ConfirmationPrompt) {
            prompts.push(prompt);
          },
        }),
  };

  return {
    spec,
    delivered,
    prompts,
    emit: (message) => require().inbound(message),
    reply: (r) => require().confirmed(r),
    get stopped() {
      return stopped;
    },
  };
}
