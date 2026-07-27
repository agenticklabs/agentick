/**
 * Closing the client releases the server-side subscriptions it opened.
 *
 * `sub/subscribe` hands the connection a cleanup callback through
 * `DispatchSink.registerSubscription`. The connection is what owns that
 * callback and what runs it on teardown — which is how a socket transport stops
 * a server-side drain loop (and interrupts its bus fiber) when a client goes
 * away. The in-process transport built its sink with FIVE no-ops for those
 * hooks, fresh per request, so nothing was ever registered and nothing was ever
 * released: the drain loop kept consuming the bus for the life of the process.
 *
 * The observable is the bus resource itself. `busAsyncIterator.return()` is what
 * interrupts the producer fiber, so a wrapper that records whether the iterator
 * was closed measures the actual leak — not a proxy for it.
 */

import { createClient } from "@agentick/client-core";
import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway } from "@agentick/gateway";
import type { EventQuery, GatewayHarnessProtocol, ProtocolEvent } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";
import { describe, expect, it } from "vitest";

import { inProcessTransport } from "../index.js";

interface OpenedStream {
  closed: boolean;
}

/**
 * The REAL gateway, with `events()` wrapped so the test can see whether each
 * iterator it handed out was closed. Everything else delegates untouched.
 */
function recordingGateway(gateway: GatewayHarnessProtocol): {
  readonly host: GatewayHarnessProtocol;
  readonly opened: OpenedStream[];
} {
  const opened: OpenedStream[] = [];
  const host = new Proxy(gateway, {
    get(target, prop) {
      if (prop === "events") {
        return (filter?: EventQuery, options?: unknown): AsyncIterable<ProtocolEvent> => ({
          [Symbol.asyncIterator]: () => {
            const inner = (
              target.events as (f?: EventQuery, o?: unknown) => AsyncIterable<ProtocolEvent>
            )(filter, options)[Symbol.asyncIterator]();
            const record: OpenedStream = { closed: false };
            opened.push(record);
            return {
              next: () => inner.next(),
              return: async (value?: unknown) => {
                record.closed = true;
                return (
                  (await inner.return?.(value)) ?? {
                    value: undefined as unknown as ProtocolEvent,
                    done: true,
                  }
                );
              },
            };
          },
        });
      }
      // Receiver is the TARGET, not the proxy — the harness reads private
      // fields, which would throw through a proxy receiver.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { host, opened };
}

type Gateway = Awaited<ReturnType<typeof createGateway>>;

/** Any harness op publishes on the gateway surface — enough to advance a drain loop. */
async function generateEvents(gateway: Gateway, appId: string): Promise<void> {
  await gateway.createApp({ appId, rootElement: null, options: { compiler: fakeCompiler() } });
}

describe("in-process transport — connection teardown", () => {
  it("client close RELEASES the server-side subscription's bus stream", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const { host, opened } = recordingGateway(gateway);
    const client = await createClient({ transport: inProcessTransport({ gateway: host }) });
    await client.connect();

    const { subscriptionId } = (await client.request("sub/subscribe", {
      scope: { kind: "gateway" },
    })) as { subscriptionId: string };
    expect(subscriptionId).toBeTruthy();
    await waitFor(() => opened.length === 1, { description: "the server-side bus stream" });
    expect(opened[0]!.closed).toBe(false);

    await client.close();

    // The drain loop notices its cleanup on the next event, so give it one.
    await generateEvents(gateway, "after-close");
    await waitFor(() => opened[0]!.closed, {
      description: "the bus stream to be released",
      timeoutMs: 2_000,
    });

    await gateway.close();
  });

  it("sub/unsubscribe RELEASES the stream too — not just forgets it", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const { host, opened } = recordingGateway(gateway);
    const client = await createClient({ transport: inProcessTransport({ gateway: host }) });
    await client.connect();

    const { subscriptionId } = (await client.request("sub/subscribe", {
      scope: { kind: "gateway" },
    })) as { subscriptionId: string };
    await waitFor(() => opened.length === 1, { description: "the server-side bus stream" });

    await client.request("sub/unsubscribe", { subscriptionId });

    await generateEvents(gateway, "after-unsubscribe");
    await waitFor(() => opened[0]!.closed, {
      description: "the bus stream to be released",
      timeoutMs: 2_000,
    });

    await client.close();
    await gateway.close();
  });
});
