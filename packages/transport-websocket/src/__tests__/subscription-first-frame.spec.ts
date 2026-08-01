/**
 * A late subscriber gets frame one — over a real socket.
 *
 * The twin of `transport-in-process`'s `subscription-first-frame.spec.ts`, run
 * where the response and the notifications are actual network frames. The
 * server publishes a session channel's snapshot as the opening frame of a fresh
 * subscription, and it used to be published BEFORE the client could learn the
 * subscription's id: the drain's first `publish` went out while the
 * `sub/subscribe` response was still unwinding, and a client whose stream was
 * still parked under a tentative id dropped it in `routeNotification`.
 *
 * The id is the client's now, so the stream is registered under its final id
 * before the request frame is written and ordering stops mattering. WS is the
 * transport where the old synchronous-re-key defence was aimed (one ordered
 * channel, `EventEmitter.emit()` delivering `[response, event, event]` in a
 * single tick with no microtask drain between them) — so it is the transport
 * where that defence's removal has to be shown not to cost anything.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createGateway } from "@agentick/gateway";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";

/** Minimal app deps — this suite exercises the wire, not the agent loop. */
function makeAppOptions() {
  return {
    rootElement: {} as unknown,
    executor: {
      target: { kind: "language-model" as const, provider: "mock", modelId: "stub" },
      project: () => ({}) as never,
      execute: () => Effect.succeed({}) as never,
      executeStream: undefined,
      normalize: () => ({}) as never,
      run: () => Effect.succeed({}) as never,
      abort: () => Effect.succeed(undefined) as never,
    } as never,
    compiler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

describe("WebSocket — a late subscriber receives the channel snapshot FIRST", () => {
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  let server: ReturnType<typeof websocketServer>;
  let httpServer: ReturnType<typeof createServer>;
  let port = 0;

  beforeEach(async () => {
    gateway = await createGateway();
    await gateway.listen();
    httpServer = createServer();
    server = websocketServer({ httpServer, gateway });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await gateway.close();
  });

  it("the knobs-state snapshot is the first frame, not a frame lost to the response race", async () => {
    // The state exists before anyone connects — a UI attaching to a live
    // session, which is the case the snapshot was built for.
    const app = await gateway.createApp({
      appId: "ws-first-frame",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    const session = await app.createSession({
      sessionId: "ws-first-frame-session",
      initialKnobs: { temperature: 0.7, verbose: true },
    });

    const transport = websocket({ url: `ws://127.0.0.1:${port}` });
    await transport.connect();

    const stream = transport.subscribe(
      { kind: "session", id: session.id },
      { surface: "session", name: { exact: "session:channel:knobs-state" } },
    );

    // The FIRST frame off the wire. No barrier, no polling — either the
    // opening frame routed or it was dropped and this hangs.
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value.envelope.name).toBe("session:channel:knobs-state");
    expect(first.value.envelope.payload).toMatchObject({
      kind: "snapshot",
      values: { temperature: 0.7, verbose: true },
    });

    await transport.close();
  });
});
