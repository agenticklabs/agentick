/**
 * ADR 107 §1 — the credentials slot: both levels, ONE harness.
 *
 * The load-bearing case is the last one. `registerNamespace` resolves by
 * proximity in the bridge tree, so an app that built its own harness would not
 * COLLIDE with the gateway's — it would occlude it wholesale, and every
 * gateway-registered provider would silently vanish for that app. The gateway
 * therefore constructs, and an app contributes into what it inherits.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { defineCredentialProvider, EPHEMERAL_NAMESPACE } from "@agentick/credentials";
import { UnknownCredentialNamespace } from "@agentick/credentials";
import { reactCompiler } from "@agentick/compiler-react";
import { createGateway } from "../index.js";

const Agent = (): React.ReactElement =>
  React.createElement("section" as never, { id: "system", audience: "model" }, "hi");

const provider = (namespace: string, value: string) =>
  defineCredentialProvider({
    namespace,
    backend: "test",
    get: () => Promise.resolve(value),
  });

describe("the credentials slot", () => {
  it("is always present, seeded with ephemeral, even when nothing is configured", async () => {
    const gateway = await createGateway({});
    try {
      expect(gateway.credentials).toBeDefined();
      expect(gateway.credentials.namespaces).toContain(EPHEMERAL_NAMESPACE);
      // A namespace nobody wired is a composition bug, not an empty read.
      await expect(gateway.credentials.get("nope", "k")).rejects.toBeInstanceOf(
        UnknownCredentialNamespace,
      );
    } finally {
      await gateway.close();
    }
  });

  it("registers gateway-level providers", async () => {
    const gateway = await createGateway({ credentials: [provider("acme", "gw-token")] });
    try {
      expect(await gateway.credentials.get("acme", "anything")).toBe("gw-token");
    } finally {
      await gateway.close();
    }
  });

  it("a hosted app SHARES the gateway's harness — one registry, not two", async () => {
    const gateway = await createGateway({ credentials: [provider("acme", "gw-token")] });
    await gateway.listen();
    try {
      const app = await gateway.createApp({
        appId: "a1",
        options: { rootElement: React.createElement(Agent), compiler: reactCompiler() },
      });

      // Same instance, so the gateway's providers are reachable from the app —
      // the occlusion this design exists to prevent.
      expect(app.credentials).toBe(gateway.credentials);
      expect(await app.credentials.get("acme", "k")).toBe("gw-token");
    } finally {
      await gateway.close();
    }
  });

  it("a standalone app builds its own, seeded the same way", async () => {
    const { createApp } = await import("@agentick/app/react");
    const app = await createApp(React.createElement(Agent), {
      credentials: [provider("local", "app-token")],
    });
    try {
      expect(app.credentials.namespaces).toContain(EPHEMERAL_NAMESPACE);
      expect(await app.credentials.get("local", "k")).toBe("app-token");
    } finally {
      await app.close();
    }
  });
});
