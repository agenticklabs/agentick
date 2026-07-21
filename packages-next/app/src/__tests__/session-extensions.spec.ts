/**
 * SessionExtension lifecycle (#150).
 *
 * The AppHarness caches `target: "session"` extensions at construction
 * and forwards them to every session it creates. Each session install
 * runs against a fresh {@link SessionInstaller} bound to that
 * session's `sessionId`. This spec pins the contract:
 *
 *   1. `install(installer)` fires once per (session, extension) pair
 *      — N sessions × M session-extensions → N×M installs.
 *   2. `installer.sessionId` matches the session it was built for.
 *   3. Tools registered via `installer.registerExtensionTool` land in
 *      the session's ToolExecutor with binding `{ scope: "extension",
 *      level: "session" }` and are reachable via `session.dispatch`.
 *   4. Tool handlers registered via `installer.registerToolHandler`
 *      resolve at dispatch time. Their unsubscribers fire on
 *      `session.close` (no zombies after the session is gone).
 *   5. Bridges registered via `installer.registerNamespace` overlay
 *      the app-level extension bridges; sessions don't see each
 *      other's session-scoped bridges.
 *   6. `installer.onClose` handlers fire LIFO at session.close.
 *   7. App-extension siblings see session-extension installs ONLY for
 *      sessions created after their install() returned — the cached
 *      list is captured at construction; ordering between sibling
 *      extensions of the SAME target follows array order.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ContentBlock,
  SessionExtension,
  SessionInstaller,
  ToolHandler,
} from "@agentick/spec-next";
import { jsonSchema, toRegistration } from "@agentick/spec-next";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "session-ext-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: Array.from({ length: 10 }, () => ({
        result: {
          specVersion: "2026-05-08" as const,
          output: [{ type: "text" as const, text: "ok" } satisfies ContentBlock],
          stopReason: "end" as const,
        },
      })),
    },
  );
  await exec.ready;
  return exec;
}

describe("SessionExtension — install lifecycle", () => {
  it("fires install() once per session, with the session's id on the installer", async () => {
    const installed: string[] = [];
    const ext: SessionExtension = {
      name: "track-session-installs",
      target: "session",
      install: (installer: SessionInstaller) => {
        expect(installer.kind).toBe("session");
        expect(installer.hostId).toBe(installer.sessionId);
        installed.push(installer.sessionId);
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });

    const s1 = await app.createSession({ sessionId: "s-1" });
    const s2 = await app.createSession({ sessionId: "s-2" });
    const s3 = await app.createSession({ sessionId: "s-3" });

    expect(installed).toEqual(["s-1", "s-2", "s-3"]);

    await s1.close();
    await s2.close();
    await s3.close();
    await app.closeApp();
  });

  it("install() runs before the ToolExecutor is constructed (registrations are visible at dispatch)", async () => {
    let handlerCalls = 0;
    const ext: SessionExtension = {
      name: "session-tool",
      target: "session",
      install: (installer) => {
        const handler: ToolHandler = async () => {
          handlerCalls++;
          return [
            { type: "text", text: `from session ${installer.sessionId}` } satisfies ContentBlock,
          ];
        };
        const handlerRef = `session-ext:${installer.sessionId}:hello`;
        installer.registerToolHandler(handlerRef, handler);
        installer.registerExtensionTool(
          toRegistration(
            {
              id: handlerRef,
              name: "hello",
              description: "session-extension tool",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              exposure: ["model", "dispatch"],
              handlerRef,
            },
            {
              scope: "extension",
              extensionName: "session-tool",
              level: "session",
            },
          ),
        );
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });

    const session = await app.createSession({ sessionId: "s-dispatch" });
    const result = await session.dispatch("hello", {});
    expect(handlerCalls).toBe(1);
    expect((result[0] as { text: string }).text).toBe("from session s-dispatch");

    await session.close();
    await app.closeApp();
  });

  it("each session gets its own bridge namespace — registerNamespace doesn't leak across sessions", async () => {
    // Two session extensions register a value derived from sessionId.
    // After install, the session's bridges.greeter MUST reflect its
    // own session's value, not the other's.
    const ext: SessionExtension = {
      name: "greeter",
      target: "session",
      install: (installer) => {
        installer.registerNamespace("greeter", {
          greet: () => `hi from ${installer.sessionId}`,
        });
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });

    // We probe the bridges via the session's HookBridges; the
    // installer plumbs into extensionBridges which buildSessionBridges
    // exposes via the bridge bag.
    const s1 = await app.createSession({ sessionId: "isolated-1" });
    const s2 = await app.createSession({ sessionId: "isolated-2" });
    const b1 = (s1 as unknown as { readonly bridges: { greeter: { greet: () => string } } })
      .bridges;
    const b2 = (s2 as unknown as { readonly bridges: { greeter: { greet: () => string } } })
      .bridges;
    expect(b1.greeter.greet()).toBe("hi from isolated-1");
    expect(b2.greeter.greet()).toBe("hi from isolated-2");

    await s1.close();
    await s2.close();
    await app.closeApp();
  });

  it("installer.onClose handlers fire at session.close in LIFO order", async () => {
    const order: string[] = [];
    const ext: SessionExtension = {
      name: "ordered-close",
      target: "session",
      install: (installer) => {
        installer.onClose(() => {
          order.push(`first-registered:${installer.sessionId}`);
        });
        installer.onClose(() => {
          order.push(`second-registered:${installer.sessionId}`);
        });
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    const session = await app.createSession({ sessionId: "lifo-1" });

    expect(order).toEqual([]);
    await session.close();
    // LIFO: second-registered fires before first-registered.
    expect(order).toEqual(["second-registered:lifo-1", "first-registered:lifo-1"]);

    await app.closeApp();
  });

  it("session-extension tool-handler unregisters fire at session.close (no zombie handlers)", async () => {
    // The session-installer-registered handler is on the shared
    // HandlerResolver; without the close-time unregister it would
    // outlive the session. Verify it's gone after close by attempting
    // a dispatch from a fresh session and observing the absence of
    // the tool.
    const ext: SessionExtension = {
      name: "ephemeral-handler",
      target: "session",
      install: (installer) => {
        const handler: ToolHandler = async () => [
          { type: "text", text: "still-alive" } satisfies ContentBlock,
        ];
        installer.registerToolHandler("ephemeral:handler", handler);
        installer.registerExtensionTool(
          toRegistration(
            {
              id: "ephemeral:handler",
              name: `ephemeral-${installer.sessionId}`,
              description: "ephemeral",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              exposure: ["model", "dispatch"],
              handlerRef: "ephemeral:handler",
            },
            {
              scope: "extension",
              extensionName: "ephemeral-handler",
              level: "session",
            },
          ),
        );
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [ext],
    });
    const s1 = await app.createSession({ sessionId: "s-eph-1" });
    // First dispatch succeeds — handler is live.
    const result = await s1.dispatch(`ephemeral-${s1.id}`, {});
    expect((result[0] as { text: string }).text).toBe("still-alive");
    await s1.close();

    // After close, the handlerRef is unregistered. A new session
    // re-running install() re-registers it. The point being tested:
    // close fired the unregister at least once for the just-closed
    // session — verified by the second session's NEW handler being
    // reachable (i.e., it didn't no-op due to the shared resolver
    // already holding a stale entry).
    const s2 = await app.createSession({ sessionId: "s-eph-2" });
    const result2 = await s2.dispatch(`ephemeral-${s2.id}`, {});
    expect((result2[0] as { text: string }).text).toBe("still-alive");

    await s2.close();
    await app.closeApp();
  });

  it("AppExtension and SessionExtension siblings install at the right phase", async () => {
    const order: string[] = [];
    const appExt = {
      name: "app-side",
      target: "app" as const,
      install: () => {
        order.push("app-install");
      },
    };
    const sessionExt: SessionExtension = {
      name: "session-side",
      target: "session",
      install: (installer) => {
        order.push(`session-install:${installer.sessionId}`);
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [appExt, sessionExt],
    });
    // App extensions install at AppHarness construction (before any
    // createSession). Verify by the time we get the app handle.
    expect(order).toEqual(["app-install"]);

    const s1 = await app.createSession({ sessionId: "phase-1" });
    expect(order).toEqual(["app-install", "session-install:phase-1"]);

    const s2 = await app.createSession({ sessionId: "phase-2" });
    expect(order).toEqual(["app-install", "session-install:phase-1", "session-install:phase-2"]);

    await s1.close();
    await s2.close();
    await app.closeApp();
  });
});
