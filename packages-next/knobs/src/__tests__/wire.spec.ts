/**
 * `knobs/set` — the knobs WRITE command at the gateway seam (slice 4).
 *
 * Drives the real `knobsWireExtension.methods["knobs/set"]` handler with a
 * stub gateway/app/session (mirrors the stub style of
 * `subscriptions-channel-snapshot.spec.ts`). The stub session records every
 * `knobs.set` call. Proven here: session resolution across apps, the wire
 * `key`/`value` → handle `id`/`value` mapping, and the unresolved-session
 * throw. The knobs handle's real `set` semantics are proven in the knobs
 * harness suite; this pins the wire projection only.
 */

import { describe, expect, it } from "vitest";
import { AppNotFoundError } from "@agentick/spec-next";
import type {
  AppHarnessProtocol,
  GatewayHarnessProtocol,
  KnobsSetInput,
  SessionHarnessProtocol,
  WireExtensionContext,
} from "@agentick/spec-next";

import { knobsWireExtension } from "../wire.js";

const SESSION_ID = "sess-1";

/** Stub session that records the args every `knobs.set` receives. */
function stubSession(calls: KnobsSetInput[]): SessionHarnessProtocol {
  return {
    id: SESSION_ID,
    knobs: {
      set: async (input: KnobsSetInput) => {
        calls.push(input);
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

const set = knobsWireExtension.methods["knobs/set"]!;

describe("knobs/set — write command (slice 4)", () => {
  it("resolves the session and invokes knobs.set with the mapped id/value", async () => {
    const calls: KnobsSetInput[] = [];
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await set({ sessionId: SESSION_ID, id: "temperature", value: 0.9 }, ctx);

    expect(calls).toEqual([{ id: "temperature", value: 0.9 }]);
    // Handle returns void; the wire row returns null (state flows via channel).
    expect(result).toBeNull();
  });

  it("maps the wire `key` onto the handle's `id` param (not `key`)", async () => {
    const calls: KnobsSetInput[] = [];
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    await set({ sessionId: SESSION_ID, id: "verbosity", value: "high" }, ctx);

    expect(calls[0]).toEqual({ id: "verbosity", value: "high" });
    expect(calls[0]).not.toHaveProperty("key");
  });

  it("throws AppNotFoundError when the session does not resolve", async () => {
    const ctx = stubCtx(stubGateway(undefined));

    await expect(
      set({ sessionId: "no-such", id: "temperature", value: 0.9 }, ctx),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });
});
