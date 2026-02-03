/**
 * Session Manager Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import { AppRegistry } from "../app-registry.js";
import type { App } from "@tentickle/core";

// Mock App for testing
function createMockApp(name: string): App {
  return {
    session: vi.fn().mockReturnValue({
      id: `session-${Date.now()}`,
      close: vi.fn(),
    }),
    run: vi.fn() as any,
    send: vi.fn() as any,
    close: vi.fn(),
    sessions: [],
    has: vi.fn(),
    isHibernated: vi.fn(),
    hibernate: vi.fn(),
    hibernatedSessions: vi.fn(),
    onSessionCreate: vi.fn(),
    onSessionClose: vi.fn(),
  } as unknown as App;
}

describe("SessionManager", () => {
  let registry: AppRegistry;
  let manager: SessionManager;
  let chatApp: App;
  let researchApp: App;

  beforeEach(() => {
    chatApp = createMockApp("chat");
    researchApp = createMockApp("research");
    registry = new AppRegistry({ chat: chatApp, research: researchApp }, "chat");
    manager = new SessionManager(registry);
  });

  describe("getOrCreate", () => {
    it("creates new session with default app", async () => {
      const session = await manager.getOrCreate("main");

      expect(session.state.id).toBe("chat:main");
      expect(session.state.appId).toBe("chat");
      expect(session.appInfo.id).toBe("chat");
      expect(session.coreSession).toBeNull();
    });

    it("creates new session with specified app", async () => {
      const session = await manager.getOrCreate("research:task-1");

      expect(session.state.id).toBe("research:task-1");
      expect(session.state.appId).toBe("research");
      expect(session.appInfo.id).toBe("research");
    });

    it("returns existing session", async () => {
      const session1 = await manager.getOrCreate("main");
      const session2 = await manager.getOrCreate("chat:main");

      expect(session1).toBe(session2);
    });

    it("updates lastActivityAt on access", async () => {
      const session1 = await manager.getOrCreate("main");
      const firstActivity = session1.state.lastActivityAt;

      // Small delay
      await new Promise((r) => setTimeout(r, 10));

      const session2 = await manager.getOrCreate("chat:main");
      expect(session2.state.lastActivityAt.getTime()).toBeGreaterThan(firstActivity.getTime());
    });
  });

  describe("get", () => {
    it("returns existing session", async () => {
      await manager.getOrCreate("main");
      const session = manager.get("chat:main");

      expect(session).toBeDefined();
      expect(session?.state.id).toBe("chat:main");
    });

    it("returns undefined for non-existent session", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  describe("has", () => {
    it("returns true for existing session", async () => {
      await manager.getOrCreate("main");
      expect(manager.has("chat:main")).toBe(true);
    });

    it("returns false for non-existent session", () => {
      expect(manager.has("nonexistent")).toBe(false);
    });
  });

  describe("close", () => {
    it("removes session", async () => {
      await manager.getOrCreate("main");
      expect(manager.has("chat:main")).toBe(true);

      await manager.close("chat:main");
      expect(manager.has("chat:main")).toBe(false);
    });

    it("handles non-existent session gracefully", async () => {
      await expect(manager.close("nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("reset", () => {
    it("resets session state", async () => {
      const session = await manager.getOrCreate("main");
      session.state.messageCount = 10;

      await manager.reset("chat:main");

      expect(session.state.messageCount).toBe(0);
    });

    it("handles non-existent session gracefully", async () => {
      await expect(manager.reset("nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("subscription management", () => {
    it("adds subscriber to session", async () => {
      await manager.getOrCreate("main");
      await manager.subscribe("chat:main", "client-1");

      const subscribers = manager.getSubscribers("chat:main");
      expect(subscribers.has("client-1")).toBe(true);
    });

    it("removes subscriber from session", async () => {
      await manager.getOrCreate("main");
      await manager.subscribe("chat:main", "client-1");
      manager.unsubscribe("chat:main", "client-1");

      const subscribers = manager.getSubscribers("chat:main");
      expect(subscribers.has("client-1")).toBe(false);
    });

    it("removes subscriber from all sessions", async () => {
      await manager.getOrCreate("main");
      await manager.getOrCreate("research:task-1");

      await manager.subscribe("chat:main", "client-1");
      await manager.subscribe("research:task-1", "client-1");

      manager.unsubscribeAll("client-1");

      expect(manager.getSubscribers("chat:main").has("client-1")).toBe(false);
      expect(manager.getSubscribers("research:task-1").has("client-1")).toBe(false);
    });

    it("returns empty set for non-existent session", () => {
      const subscribers = manager.getSubscribers("nonexistent");
      expect(subscribers.size).toBe(0);
    });
  });

  describe("message count", () => {
    it("increments message count", async () => {
      await manager.getOrCreate("main");
      expect(manager.get("chat:main")?.state.messageCount).toBe(0);

      manager.incrementMessageCount("chat:main");
      expect(manager.get("chat:main")?.state.messageCount).toBe(1);

      manager.incrementMessageCount("chat:main");
      expect(manager.get("chat:main")?.state.messageCount).toBe(2);
    });
  });

  describe("active state", () => {
    it("sets active state", async () => {
      await manager.getOrCreate("main");
      expect(manager.get("chat:main")?.state.isActive).toBe(false);

      manager.setActive("chat:main", true);
      expect(manager.get("chat:main")?.state.isActive).toBe(true);

      manager.setActive("chat:main", false);
      expect(manager.get("chat:main")?.state.isActive).toBe(false);
    });
  });

  describe("listing", () => {
    it("returns all session ids", async () => {
      await manager.getOrCreate("main");
      await manager.getOrCreate("research:task-1");

      const ids = manager.ids();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("chat:main");
      expect(ids).toContain("research:task-1");
    });

    it("returns sessions for specific app", async () => {
      await manager.getOrCreate("main");
      await manager.getOrCreate("chat:other");
      await manager.getOrCreate("research:task-1");

      const chatSessions = manager.forApp("chat");
      expect(chatSessions).toHaveLength(2);

      const researchSessions = manager.forApp("research");
      expect(researchSessions).toHaveLength(1);
    });
  });
});
