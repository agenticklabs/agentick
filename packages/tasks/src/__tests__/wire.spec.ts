/**
 * `tasks/cancel` — the tasks WRITE command at the gateway seam.
 *
 * Drives the real `tasksWireExtension.methods["tasks/cancel"]` handler with a
 * stub gateway/app/session (mirrors `knobs/src/__tests__/wire.spec.ts`). The
 * stub session records every `tasks.cancel` call. Proven here: session
 * resolution across apps, the `taskId`/`reason` passthrough, and the
 * unresolved-session throw. The `cancel` semantics themselves (terminal
 * transition, store effect) are proven in the tasks harness suite; this pins
 * the wire projection only.
 */

import { describe, expect, it } from "vitest";
import { AppNotFoundError } from "@agentick/spec";
import type {
  AppHarnessProtocol,
  GatewayHarnessProtocol,
  SessionHarnessProtocol,
  WireExtensionContext,
} from "@agentick/spec";

import { fakeGatewayHarness } from "@agentick/spec-conformance";

import { tasksWireExtension } from "../wire.js";

const SESSION_ID = "sess-1";

type CancelCall = { taskId: string; reason?: string };

/** Stub session that records the args every `tasks.cancel` receives. */
function stubSession(calls: CancelCall[]): SessionHarnessProtocol {
  return {
    id: SESSION_ID,
    tasks: {
      cancel: async (taskId: string, reason?: string) => {
        calls.push({ taskId, reason });
      },
    },
  } as unknown as SessionHarnessProtocol;
}

function stubGateway(session: SessionHarnessProtocol | undefined): GatewayHarnessProtocol {
  const app = {
    getSession: (id: string) => (session && id === SESSION_ID ? session : undefined),
  } as unknown as AppHarnessProtocol;
  return fakeGatewayHarness({ apps: [app] });
}

function stubCtx(gateway: GatewayHarnessProtocol): WireExtensionContext {
  return { gateway } as unknown as WireExtensionContext;
}

const cancel = tasksWireExtension.methods["tasks/cancel"]!;

describe("tasks/cancel — write command", () => {
  it("resolves the session and invokes tasks.cancel with taskId and reason", async () => {
    const calls: CancelCall[] = [];
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    const result = await cancel(
      { sessionId: SESSION_ID, taskId: "task-7", reason: "superseded" },
      ctx,
    );

    expect(calls).toEqual([{ taskId: "task-7", reason: "superseded" }]);
    // Handle returns void; the wire row returns null (state flows via channel).
    expect(result).toBeNull();
  });

  it("passes taskId through with reason undefined when omitted", async () => {
    const calls: CancelCall[] = [];
    const ctx = stubCtx(stubGateway(stubSession(calls)));

    await cancel({ sessionId: SESSION_ID, taskId: "task-9" }, ctx);

    expect(calls[0]).toEqual({ taskId: "task-9", reason: undefined });
  });

  it("throws AppNotFoundError when the session does not resolve", async () => {
    const ctx = stubCtx(stubGateway(undefined));

    await expect(cancel({ sessionId: "no-such", taskId: "task-7" }, ctx)).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });
});
