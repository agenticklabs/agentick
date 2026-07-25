/**
 * G2-wire-errors — typed AgentickError rehydration on the client request path.
 *
 * The server's dispatch stamps a thrown AgentickError's `toJSON()` into
 * JSON-RPC `error.data` ({ _tag, message, ...fields }); the transport rejects
 * with the raw `{ kind: "rpc", error }` envelope. `createClient` rehydrates
 * ABOVE the extension pipeline via spec's registry-driven codec, so
 * `catch (e) { e instanceof GateNotFound }` holds identically on both sides
 * of the wire. Unknown tags degrade to `UnknownAgentickError` (no data loss);
 * protocol-level errors (no `_tag` in data) keep the raw envelope shape the
 * duck-typed helpers and retry/offline extensions classify by.
 *
 * @verifiedBy this suite — the client-core rehydration seam.
 * @see ../client.ts (rehydrateWireError) and transport/server/dispatch.ts
 *   (the tag→code table + `toJSON()` stamping this rehydrates from)
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  GateNotFound,
  SessionNotFoundError,
  UnknownAgentickError,
  serializeAgentickError,
  type ClientState,
  type ClientTransport,
  type InitializeResult,
  type ProgressStream,
  type SubscriptionStream,
  type TransportCapabilities,
  type WireMethod,
  type WireParams,
  type WireResult,
} from "@agentick/spec";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/** Fake transport — handshake methods answered, everything else to `handler`. */
function fakeTransport(handler: Handler): ClientTransport {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const notify = (s: ClientState) => {
    state = s;
    for (const l of listeners) l(s);
  };
  const initResult: InitializeResult = {
    protocolVersion: "v1",
    capabilities: { cursorResume: true, subscriptions: true, progress: true, cancellation: true },
    serverInfo: { name: "@test/gateway", version: "0.0.0" },
    connectionId: "conn-1",
  };
  return {
    id: "fake",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
      media: false,
    } satisfies TransportCapabilities,
    get state() {
      return state;
    },
    async connect() {
      notify("connecting");
      notify("open");
    },
    async close() {
      notify("closed");
    },
    request: (async (method: WireMethod, params: unknown) => {
      if (method === "initialize") return initResult;
      if (method === "_extensions/list") return { extensions: [] };
      return handler(method as never, params as never);
    }) as ClientTransport["request"],
    subscribe: (): SubscriptionStream => {
      throw new Error("subscribe not used here");
    },
    progress: (): ProgressStream => {
      throw new Error("progress not used here");
    },
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
}

/** The wire envelope the transport rejects with for a JSON-RPC error. */
function rpcEnvelope(code: number, message: string, data?: unknown) {
  return { kind: "rpc" as const, error: { code, message, data } };
}

describe("G2-wire-errors — client-side AgentickError rehydration", () => {
  it("a server AgentickError in error.data rehydrates to the typed instance", async () => {
    const original = new GateNotFound({ gateName: "deploy" });
    const transport = fakeTransport(async () => {
      throw rpcEnvelope(ErrorCode.Forbidden, original.message, serializeAgentickError(original));
    });
    const client = await createClient({ transport });

    const caught = await client
      .request("session/abort", { sessionId: "s1" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    // Same class object as the server side — spec is the shared home.
    expect(caught).toBeInstanceOf(GateNotFound);
    const e = caught as GateNotFound;
    expect(e._tag).toBe("GateNotFound");
    expect(e.gateName).toBe("deploy");
    expect(e.message).toBe(original.message);
    await client.close();
  });

  it("fields round-trip: SessionNotFoundError keeps sessionId", async () => {
    const transport = fakeTransport(async () => {
      throw rpcEnvelope(
        ErrorCode.SessionNotFound,
        "session ghost not found",
        serializeAgentickError(new SessionNotFoundError({ sessionId: "ghost" })),
      );
    });
    const client = await createClient({ transport });

    const caught = await client
      .request("session/snapshot", { sessionId: "ghost" })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(SessionNotFoundError);
    expect((caught as SessionNotFoundError).sessionId).toBe("ghost");
    await client.close();
  });

  it("an unknown _tag degrades to UnknownAgentickError, payload preserved", async () => {
    const transport = fakeTransport(async () => {
      throw rpcEnvelope(ErrorCode.InternalError, "boom", {
        _tag: "ErrorFromTheFuture",
        message: "boom",
        futureField: 42,
      });
    });
    const client = await createClient({ transport });

    const caught = await client
      .request("session/abort", { sessionId: "s1" })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UnknownAgentickError);
    const e = caught as UnknownAgentickError;
    expect(e.originalTag).toBe("ErrorFromTheFuture");
    await client.close();
  });

  it("protocol-level errors (no _tag) keep the raw rpc envelope", async () => {
    const envelope = rpcEnvelope(ErrorCode.MethodNotFound, "no such method");
    const transport = fakeTransport(async () => {
      throw envelope;
    });
    const client = await createClient({ transport });

    const caught = await client
      .request("session/abort", { sessionId: "s1" })
      .catch((e: unknown) => e);
    // Untouched — duck-typed consumers (isMethodNotFound, retry predicates)
    // keep classifying by the wire envelope.
    expect(caught).toBe(envelope);
    await client.close();
  });

  it("non-object rejections (connection shapes, plain Errors) pass through", async () => {
    const plain = new Error("socket closed");
    const transport = fakeTransport(async () => {
      throw plain;
    });
    const client = await createClient({ transport });

    const caught = await client
      .request("session/abort", { sessionId: "s1" })
      .catch((e: unknown) => e);
    expect(caught).toBe(plain);
    await client.close();
  });
});
