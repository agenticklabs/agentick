/**
 * `live/*` — the live control-plane commands at the gateway seam.
 *
 * Drives the real `liveWireExtension` handlers with a stub gateway/app/session
 * (mirrors `tasks/src/__tests__/wire.spec.ts`). The stub session records every
 * `live.start` / `live.stop` / `live.interrupt` call. Proven here: session
 * resolution across apps, the param passthrough, the minted-ref return, and the
 * unresolved-session throw. The routing semantics themselves are proven in the
 * harness suite; this pins the wire projection only.
 */

import { describe, expect, it } from "vitest";
import { AppNotFoundError } from "@agentick/spec-next";
import type {
  AppHarnessProtocol,
  GatewayHarnessProtocol,
  MediaSessionRef,
  SessionHarnessProtocol,
  WireExtensionContext,
} from "@agentick/spec-next";

import { liveWireExtension } from "../wire.js";

const SESSION_ID = "sess-1";

interface LiveCalls {
  start: Array<string | undefined>;
  stop: Array<{ streamId: string; opts?: { hard?: boolean; reason?: string } }>;
  interrupt: Array<{ streamId: string; playedMs?: number }>;
}

function stubSession(calls: LiveCalls): SessionHarnessProtocol {
  return {
    id: SESSION_ID,
    live: {
      start: (streamId?: string): MediaSessionRef => {
        calls.start.push(streamId);
        return { sessionId: SESSION_ID, streamId: streamId ?? "minted-1" };
      },
      stop: async (streamId: string, opts?: { hard?: boolean; reason?: string }) => {
        calls.stop.push({ streamId, ...(opts ? { opts } : {}) });
      },
      interrupt: (streamId: string, playedMs?: number) => {
        calls.interrupt.push({ streamId, playedMs });
      },
    },
  } as unknown as SessionHarnessProtocol;
}

function stubGateway(session: SessionHarnessProtocol | undefined): GatewayHarnessProtocol {
  const app = {
    getSession: (id: string) => (session && id === SESSION_ID ? session : undefined),
  } as unknown as AppHarnessProtocol;
  return {
    apps: () => [app],
    app: () => app,
  } as unknown as GatewayHarnessProtocol;
}

function stubCtx(gateway: GatewayHarnessProtocol): WireExtensionContext {
  return { gateway } as unknown as WireExtensionContext;
}

function emptyCalls(): LiveCalls {
  return { start: [], stop: [], interrupt: [] };
}

const start = liveWireExtension.methods["live/start"]!;
const stop = liveWireExtension.methods["live/stop"]!;
const interrupt = liveWireExtension.methods["live/interrupt"]!;

describe("live/start", () => {
  it("resolves the session, opens a stream, and returns the ref", async () => {
    const calls = emptyCalls();
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await start({ sessionId: SESSION_ID, streamId: "s7" }, ctx);

    expect(calls.start).toEqual(["s7"]);
    expect(result).toEqual({ sessionId: SESSION_ID, streamId: "s7" });
  });

  it("passes streamId undefined when omitted (server mints)", async () => {
    const calls = emptyCalls();
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await start({ sessionId: SESSION_ID }, ctx);

    expect(calls.start).toEqual([undefined]);
    expect(result).toEqual({ sessionId: SESSION_ID, streamId: "minted-1" });
  });

  it("throws AppNotFoundError when the session does not resolve", async () => {
    const ctx = stubCtx(stubGateway(undefined));
    await expect(start({ sessionId: "no-such", streamId: "s7" }, ctx)).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });
});

describe("live/stop", () => {
  it("routes to session.live.stop with hard/reason, returns null", async () => {
    const calls = emptyCalls();
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await stop(
      { sessionId: SESSION_ID, streamId: "s7", hard: true, reason: "bye" },
      ctx,
    );

    expect(calls.stop).toEqual([{ streamId: "s7", opts: { hard: true, reason: "bye" } }]);
    expect(result).toBeNull();
  });

  it("omits hard/reason from opts when not given", async () => {
    const calls = emptyCalls();
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    await stop({ sessionId: SESSION_ID, streamId: "s7" }, ctx);

    expect(calls.stop).toEqual([{ streamId: "s7", opts: {} }]);
  });
});

describe("live/interrupt", () => {
  it("routes to session.live.interrupt with playedMs, returns null", async () => {
    const calls = emptyCalls();
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await interrupt({ sessionId: SESSION_ID, streamId: "s7", playedMs: 1200 }, ctx);

    expect(calls.interrupt).toEqual([{ streamId: "s7", playedMs: 1200 }]);
    expect(result).toBeNull();
  });
});
