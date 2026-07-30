/**
 * A JSON-RPC error RESPONSE must reach the caller with the SERVER'S words on it.
 *
 * The server answers a failed request with `{ code, message, data }` — the one
 * place in the whole failure path where a human-readable explanation exists
 * ("prompt argument 'topic' is required"). `routeResponse` wraps that envelope
 * in a `TransportFailure`, and if the wrapper synthesises its own message the
 * explanation is gone from every `console.error(err)` and every log line: what
 * reaches the developer is `transport error (rpc)` and nothing else.
 *
 * This suite pins both halves — the readable message AND the structured payload
 * (`kind`, `error.code`, `error.data`) that `@agentick/client-core` rehydrates
 * typed `AgentickError`s out of.
 *
 * `routeResponse` lives on `BaseClientTransport`, so this covers the WebSocket,
 * HTTP, Unix-socket and in-process transports alike — every one of them routes
 * inbound responses through it (verified by grep: no transport rejects an RPC
 * error on its own).
 *
 * @verifiedBy this suite — the transport-side error fidelity contract.
 * @see ../client/transport-failure.ts
 */

import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "@agentick/spec";
import { isTransportError } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { BaseClientTransport } from "../client/base-transport.js";
import { transportError } from "../client/transport-failure.js";

/** Minimal wire: every request is answered by the supplied function. */
class StubTransport extends BaseClientTransport {
  readonly id = "stub";
  readonly capabilities = {
    bidirectional: true,
    streamingRequest: false,
    reconnectable: false,
    binaryFrames: false,
    media: false,
  };

  constructor(private readonly answer: (req: JsonRpcRequest) => JsonRpcResponse) {
    super();
    this.keepalivePolicy = { ...this.keepalivePolicy, enabled: false };
    this.reconnectPolicy = { ...this.reconnectPolicy, enabled: false };
  }

  protected async openConnection(): Promise<void> {
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    if (!("id" in frame)) return;
    this.routeFrame(this.answer(frame as JsonRpcRequest) as JsonRpcFrame);
  }
}

/** Answer every request with this JSON-RPC error. */
function transportRejecting(error: {
  code: number;
  message: string;
  data?: unknown;
}): StubTransport {
  return new StubTransport((req) => ({ jsonrpc: "2.0", id: req.id, error }));
}

const PROMPT_ARGUMENT_MISSING = {
  code: -32602,
  message: "prompt 'summarize' requires argument 'topic'",
  data: { _tag: "PromptArgumentMissing", promptName: "summarize", argument: "topic" },
};

describe("RPC error responses keep the server's message", () => {
  it("the rejection's `message` contains the server's message", async () => {
    const transport = transportRejecting(PROMPT_ARGUMENT_MISSING);
    await transport.connect();

    const caught = await transport.request("ping", {}).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("prompt 'summarize' requires argument 'topic'");
    await transport.close();
  });

  it("the JSON-RPC code is in the message too — a log line correlates without a debugger", async () => {
    const transport = transportRejecting(PROMPT_ARGUMENT_MISSING);
    await transport.connect();

    const caught = await transport.request("ping", {}).catch((e: unknown) => e);

    expect((caught as Error).message).toContain("-32602");
    await transport.close();
  });

  it("the structured payload survives: kind, code, data all reachable", async () => {
    const transport = transportRejecting(PROMPT_ARGUMENT_MISSING);
    await transport.connect();

    const caught = (await transport.request("ping", {}).catch((e: unknown) => e)) as {
      kind: string;
      error: { code: number; message: string; data: unknown };
    };

    expect(isTransportError(caught)).toBe(true);
    expect(caught.kind).toBe("rpc");
    expect(caught.error.code).toBe(-32602);
    expect(caught.error.message).toBe(PROMPT_ARGUMENT_MISSING.message);
    // client-core rehydrates a typed AgentickError out of exactly this.
    expect(caught.error.data).toEqual(PROMPT_ARGUMENT_MISSING.data);
    await transport.close();
  });

  it("a message-less server error still names its code", () => {
    const failure = transportError({ kind: "rpc", error: { code: -32603, message: "" } });

    expect(failure.message).toBe("rpc error -32603");
  });

  it("kinds that carry their own message use it verbatim", () => {
    expect(transportError({ kind: "closed", message: "transport closing" }).message).toBe(
      "transport closing",
    );
    expect(transportError({ kind: "cancelled", message: "aborted" }).message).toBe("aborted");
  });
});
