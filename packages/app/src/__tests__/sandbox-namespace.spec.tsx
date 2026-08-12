/**
 * The `sandbox` namespace at the adopter's entry point —
 * `createApp({ sandbox: defineSandbox() })`.
 *
 * Conformance certifies the parts; this is the configuration an adopter
 * actually writes, with the REAL local provider. It pins the slot resolving to
 * a working `SandboxBridge`, the auto-spun `"primary"` jail reachable through
 * the `ctx.sandbox` door a sandbox tool uses, and an omitted slot installing
 * nothing.
 *
 * @verifiedBy this file
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { defineSandbox } from "@agentick/sandbox-local";
import type { SandboxBridge } from "@agentick/sandbox";
import type { ContentBlock, SessionExtension, ToolHandler } from "@agentick/spec";
import { jsonSchema, toRegistration } from "@agentick/spec";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "sandbox host");

const permissive = { read: ["**"], write: ["**"], exec: { allow: ["**"] } } as const;

function bridgeOf(session: unknown): SandboxBridge | undefined {
  return (session as { readonly bridges: Record<string, unknown> }).bridges.sandbox as
    | SandboxBridge
    | undefined;
}

describe("createApp({ sandbox }) — the adopter entry point", () => {
  it("`sandbox: defineSandbox()` spins the primary jail, reachable via bridges.sandbox", async () => {
    const app = await createApp(React.createElement(Agent), {
      sandbox: defineSandbox({ allow: permissive }),
    });
    const session = await app.createSession({ sessionId: "s-sandbox-default" });

    const bridge = bridgeOf(session);
    expect(bridge).toBeDefined();

    const primary = bridge!.get("primary");
    expect(primary).toBeDefined();
    expect(primary!.workspacePath).toBeTruthy();

    // A real jail, spun from the local provider with no <Sandbox> JSX at all.
    const result = await primary!.exec({ command: "echo composed" });
    expect(result.stdout.trim()).toBe("composed");

    await session.close();
    await app.close();
  });

  it("a tool handler reaches the same bridge through ctx.sandbox", async () => {
    let seenWorkspace: string | undefined;
    const probe: SessionExtension = {
      name: "sandbox-ctx-probe",
      target: "session",
      install: (installer) => {
        const handler: ToolHandler = async (_input, deps) => {
          const bridge = (deps as { readonly ctx: { readonly sandbox?: SandboxBridge } }).ctx
            .sandbox;
          seenWorkspace = bridge?.get("primary")?.workspacePath;
          return [{ type: "text", text: "ok" } satisfies ContentBlock];
        };
        const handlerRef = `sandbox-ctx-probe:${installer.sessionId}`;
        installer.registerToolHandler(handlerRef, handler);
        installer.registerExtensionTool(
          toRegistration(
            {
              id: handlerRef,
              name: "probe_sandbox",
              description: "reads ctx.sandbox",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              exposure: ["dispatch"],
              handlerRef,
            },
            { scope: "extension", extensionName: "sandbox-ctx-probe", level: "session" },
          ),
        );
      },
    };

    const app = await createApp(React.createElement(Agent), {
      sandbox: defineSandbox({ allow: permissive }),
      extensions: [probe],
    });
    const session = await app.createSession({ sessionId: "s-sandbox-ctx" });

    await session.tools.dispatch("probe_sandbox", {});
    expect(seenWorkspace).toBe(bridgeOf(session)!.get("primary")!.workspacePath);

    await session.close();
    await app.close();
  });

  it("an omitted slot installs nothing — no phantom namespace", async () => {
    const app = await createApp(React.createElement(Agent), {});
    const session = await app.createSession({ sessionId: "s-sandbox-absent" });

    expect(bridgeOf(session)).toBeUndefined();

    await session.close();
    await app.close();
  });
});
