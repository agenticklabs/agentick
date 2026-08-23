/**
 * Connecting to a gateway that was NOT there when the client started.
 *
 * The sibling `reconnect-e2e.spec.ts` proves the WIRE comes back: a dead port
 * that starts listening, a server that dies and returns, a silently blackholed
 * path. Every one of those cases holds two things constant that real use does
 * not — the dial either succeeds or FAILS promptly, and the client carries no
 * live subscription.
 *
 * Both defects reported from the browser live in exactly that gap:
 *
 *   (A) the client starts while the backend is DOWN behind something that is
 *       UP — a dev-server proxy, an ingress, a load balancer. The TCP connect
 *       succeeds and the upgrade never completes, so the dial neither resolves
 *       nor rejects. Nothing arms the backoff loop, because the loop is armed
 *       by failure and this dial never fails. The client sits in `connecting`
 *       forever, including long after the backend comes up.
 *
 *   (B) the backend RESTARTS. The wire comes back in milliseconds, before the
 *       adopter has re-established anything, so the transport's automatic
 *       resubscribe asks a gateway whose session registry is EMPTY. The scope
 *       target is missing for a few hundred milliseconds and the subscription
 *       was killed permanently for it — a client on a live wire that never
 *       receives another event.
 *
 * @see ../client/transport.ts
 * @see ../../../transport/src/client/base-transport.ts
 */

import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";

import { createGateway, staticAuthorizer } from "@agentick/gateway";
import { createClient } from "@agentick/client-core";
import type {
  AppHarnessProtocol,
  Authorizer,
  ClientState,
  EventFrame,
  SubscriptionStream,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { websocket } from "../client/index.js";
import { websocketServer } from "../server/index.js";

/** Reservoir of teardown thunks, drained LIFO in `afterEach`. */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      /* teardown is best-effort */
    }
  }
});

function label(s: ClientState): string {
  return typeof s === "string" ? s : `failed:${s.kind}`;
}

/** Grab an ephemeral port by listening on :0 and immediately releasing it. */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Minimal app deps — these suites exercise the wire, not the agent loop. */
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

interface Standing {
  readonly port: number;
  readonly app: AppHarnessProtocol;
  /** Upgrade requests the HTTP server accepted — a competing-dial detector. */
  readonly accepted: () => number;
  stop(): Promise<void>;
}

const APP_ID = "chat";

/** Stand a real gateway-backed WS server on `port` (0 = ephemeral), with an app. */
async function standServer(port = 0, options: { authorizer?: Authorizer } = {}): Promise<Standing> {
  const gateway = await createGateway(options.authorizer ? { authorizer: options.authorizer } : {});
  await gateway.listen();
  const app = await gateway.createApp({
    appId: APP_ID,
    rootElement: {} as unknown,
    options: makeAppOptions() as never,
  });
  const httpServer: HttpServer = createServer();
  let accepted = 0;
  httpServer.on("upgrade", () => {
    accepted++;
  });
  const server = websocketServer({ httpServer, gateway });
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  const bound = (httpServer.address() as AddressInfo).port;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await gateway.close();
  };
  cleanups.push(stop);
  return { port: bound, app: app as AppHarnessProtocol, accepted: () => accepted, stop };
}

interface BlackHole {
  readonly port: number;
  /** TCP connections accepted and then ignored. */
  readonly accepted: () => number;
  stop(): Promise<void>;
}

/**
 * A listener that ACCEPTS the TCP connection and then does nothing at all — no
 * upgrade response, no error, no close. What a dev-server proxy, an ingress, or
 * an LB in front of a dead upstream looks like from the browser: the socket
 * neither opens nor fails.
 */
async function standBlackHole(port = 0): Promise<BlackHole> {
  let accepted = 0;
  const held: Array<{ destroy(): void }> = [];
  const server: TcpServer = createTcpServer((socket) => {
    accepted++;
    held.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const bound = (server.address() as AddressInfo).port;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const s of held) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  return { port: bound, accepted: () => accepted, stop };
}

/** Pull the next frame off a subscription, or fail after `timeoutMs`. */
async function nextFrame(stream: SubscriptionStream, timeoutMs = 3_000): Promise<EventFrame> {
  const iterator = stream[Symbol.asyncIterator]();
  const settled = await Promise.race([
    iterator.next(),
    new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), timeoutMs)),
  ]);
  if (settled === "TIMEOUT") throw new Error(`no frame within ${timeoutMs}ms`);
  if (settled.done) throw new Error("subscription stream ENDED instead of delivering a frame");
  return settled.value;
}

describe("(A) a backend that is down behind something that is up", () => {
  it("gives up on a dial that never answers and keeps retrying", async () => {
    const hole = await standBlackHole();

    const states: string[] = [];
    const transport = websocket({
      url: `ws://127.0.0.1:${hole.port}`,
      reconnect: { initialDelayMs: 20, maxDelayMs: 40, dialTimeoutMs: 150 },
    });
    cleanups.push(() => transport.close());
    transport.onStateChange((s) => states.push(label(s)));

    // The dial hangs: TCP connected, upgrade never answered. It has to be
    // ABANDONED on a deadline — nothing else will ever report it, and a
    // transport parked in `connecting` forever is the never-connects bug.
    await transport.connect().catch(() => {});

    await waitFor(() => hole.accepted() >= 3, {
      timeoutMs: 5_000,
      description: "the client abandoned the hung dial and redialed",
    });
    expect(states).toContain("reconnecting");
    expect(states).not.toContain("closed");
  });

  it("connects once the real backend replaces the black hole", async () => {
    const port = await reservePort();
    const hole = await standBlackHole(port);

    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 40, dialTimeoutMs: 150 },
      }),
    });
    cleanups.push(() => client.close());

    await client.connect().catch(() => {});
    await waitFor(() => hole.accepted() >= 2, {
      timeoutMs: 5_000,
      description: "retrying against the black hole",
    });

    // The backend finally boots and takes the port.
    await hole.stop();
    await standServer(port);

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client reached the real backend",
    });
    await client.whenReady();
    expect(await client.request("ping", {})).toEqual({});
  });

  it("connect() during an in-flight dial joins it instead of racing it", async () => {
    const hole = await standBlackHole();

    const transport = websocket({
      url: `ws://127.0.0.1:${hole.port}`,
      // Long enough that both calls are in flight together; the point is that
      // the SECOND must not open a second socket.
      reconnect: { initialDelayMs: 5_000, maxDelayMs: 5_000, dialTimeoutMs: 400 },
    });
    cleanups.push(() => transport.close());

    const first = transport.connect().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await new Promise((r) => setTimeout(r, 50));
    const second = transport.connect().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    // A dial that loses a race is a socket nobody owns: its listeners are
    // muted by the staleness guard, so it never settles its caller's promise
    // and never closes. Both symptoms, one cause — so both are asserted.
    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise((r) => setTimeout(() => r("HUNG"), 3_000)),
    ]);
    expect(settled).not.toBe("HUNG");
    expect(hole.accepted()).toBe(1);
  });
});

describe("(B) a backend that restarted under a connected client", () => {
  it("a session subscription survives a gateway whose session registry is EMPTY", async () => {
    const first = await standServer();
    const { port } = first;
    await first.app.createSession({
      sessionId: "s1",
      initialKnobs: { temperature: 0.7 },
    } as never);

    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 40 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());
    await client.connect();

    const stream = client.session("s1").events({
      surface: "session",
      name: { exact: "session:channel:knobs-state" },
    });
    const opening = await nextFrame(stream);
    expect(opening.envelope.payload).toMatchObject({ values: { temperature: 0.7 } });

    // The backend restarts. A NEW gateway process on the same port: no
    // connection registry, no sessions. Wait for the DROP to be observed
    // before standing the replacement — otherwise the reconnect can land
    // after the session has been re-created and the race never happens.
    await first.stop();
    await waitFor(() => states.includes("reconnecting"), {
      timeoutMs: 5_000,
      description: "client observed the drop",
    });
    const second = await standServer(port);

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client re-opened against the fresh gateway",
    });
    await client.whenReady();

    // The transport has now resubscribed — against an empty registry. Since
    // ADR 102 stage 3 that subscription is ADMITTED and quiet rather than
    // refused, so the stream is already open across the gap. Give it a beat to
    // have been re-established before the session exists.
    await new Promise((r) => setTimeout(r, 100));

    // NOW the adopter re-establishes the session, exactly as a create-or-resume
    // does once the client reports ready.
    await second.app.createSession({
      sessionId: "s1",
      initialKnobs: { temperature: 0.2 },
    } as never);

    // The subscription must heal. A scope that is missing for a few hundred
    // milliseconds after a peer restart is a race with the client's own
    // re-establishment, not a verdict — killing the stream for it is how a UI
    // reconnects to a live wire and never updates again. Since the stream was
    // open across the whole mount it carries the channel being BUILT — its
    // opening snapshot, then the delta that sets the knob — where a
    // subscription established afterwards would open on a snapshot already
    // holding it.
    const reopened = await nextFrame(stream, 5_000);
    expect(reopened.envelope.payload).toMatchObject({ kind: "snapshot", values: {} });
    const healed = await nextFrame(stream, 5_000);
    expect(healed.envelope.payload).toMatchObject({
      kind: "delta",
      ops: [{ op: "add", path: "/temperature", value: 0.2 }],
    });
  });

  it("a resubscribe the fresh gateway REFUSES ends that stream, and only that stream", async () => {
    const first = await standServer();
    const { port } = first;

    const states: string[] = [];
    const client = await createClient({
      transport: websocket({
        url: `ws://127.0.0.1:${port}`,
        reconnect: { initialDelayMs: 20, maxDelayMs: 40 },
      }),
      onStateChange: (s) => states.push(label(s)),
    });
    cleanups.push(() => client.close());
    await client.connect();

    const stream = client.app(APP_ID).events();
    const ended = (async () => {
      try {
        for await (const _ of stream) void _;
        return "ended-clean" as const;
      } catch (e) {
        return e;
      }
    })();

    // The peer we come back to REFUSES the resubscribe — a policy verdict, not
    // a scope that has yet to be rebuilt. Waiting changes nothing, so the
    // subscription is terminal and its consumer has to be told.
    await first.stop();
    await waitFor(() => states.includes("reconnecting"), {
      timeoutMs: 5_000,
      description: "client observed the drop",
    });
    await standServer(port, {
      authorizer: staticAuthorizer({ grants: {}, anonymous: ["app:*", "session:*", "gateway:*"] }),
    });

    await waitFor(() => client.state === "open", {
      timeoutMs: 5_000,
      description: "client re-opened",
    });
    await client.whenReady();

    const outcome = await Promise.race([
      ended,
      new Promise((r) => setTimeout(() => r("STILL-OPEN"), 2_000)),
    ]);
    expect(outcome).not.toBe("STILL-OPEN");
    expect(outcome).not.toBe("ended-clean");

    // The wire is alive and serving even though a subscription on it died.
    expect(await client.request("ping", {})).toEqual({});
    expect(client.readiness).toBe("ready");
  });
});
