/**
 * Agent Registry Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRegistry } from "../agent-registry.js";
import type { App } from "@tentickle/core";

// Mock App for testing
function createMockApp(name: string): App {
  return {
    session: vi.fn(),
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
    // Add a name for identification in tests
    _name: name,
  } as unknown as App;
}

describe("AgentRegistry", () => {
  let chatApp: App;
  let researchApp: App;
  let coderApp: App;

  beforeEach(() => {
    chatApp = createMockApp("chat");
    researchApp = createMockApp("research");
    coderApp = createMockApp("coder");
  });

  describe("constructor", () => {
    it("creates registry with agents and default", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      expect(registry.size).toBe(2);
      expect(registry.defaultId).toBe("chat");
    });

    it("throws if default agent not in agents", () => {
      expect(() => {
        new AgentRegistry({ chat: chatApp }, "nonexistent");
      }).toThrow('Default agent "nonexistent" not found');
    });

    it("throws if agents is empty", () => {
      expect(() => {
        new AgentRegistry({}, "chat");
      }).toThrow('Default agent "chat" not found');
    });
  });

  describe("get", () => {
    it("returns agent by id", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      const agent = registry.get("research");
      expect(agent).toBeDefined();
      expect(agent?.id).toBe("research");
      expect(agent?.app).toBe(researchApp);
    });

    it("returns undefined for unknown id", () => {
      const registry = new AgentRegistry({ chat: chatApp }, "chat");
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("getDefault", () => {
    it("returns default agent", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "research");

      const agent = registry.getDefault();
      expect(agent.id).toBe("research");
      expect(agent.app).toBe(researchApp);
      expect(agent.isDefault).toBe(true);
    });
  });

  describe("has", () => {
    it("returns true for existing agent", () => {
      const registry = new AgentRegistry({ chat: chatApp }, "chat");
      expect(registry.has("chat")).toBe(true);
    });

    it("returns false for unknown agent", () => {
      const registry = new AgentRegistry({ chat: chatApp }, "chat");
      expect(registry.has("unknown")).toBe(false);
    });
  });

  describe("ids", () => {
    it("returns all agent ids", () => {
      const registry = new AgentRegistry(
        { chat: chatApp, research: researchApp, coder: coderApp },
        "chat",
      );

      const ids = registry.ids();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("chat");
      expect(ids).toContain("research");
      expect(ids).toContain("coder");
    });
  });

  describe("all", () => {
    it("returns all agents with metadata", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      const agents = registry.all();
      expect(agents).toHaveLength(2);

      const chatAgent = agents.find((a) => a.id === "chat");
      expect(chatAgent?.isDefault).toBe(true);

      const researchAgent = agents.find((a) => a.id === "research");
      expect(researchAgent?.isDefault).toBe(false);
    });
  });

  describe("resolve", () => {
    it("resolves to specified agent", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      const agent = registry.resolve("research");
      expect(agent.id).toBe("research");
    });

    it("resolves to default when no id provided", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      const agent = registry.resolve();
      expect(agent.id).toBe("chat");
    });

    it("resolves to default for undefined", () => {
      const registry = new AgentRegistry({ chat: chatApp, research: researchApp }, "chat");

      const agent = registry.resolve(undefined);
      expect(agent.id).toBe("chat");
    });

    it("throws for unknown agent", () => {
      const registry = new AgentRegistry({ chat: chatApp }, "chat");

      expect(() => registry.resolve("unknown")).toThrow('Unknown agent "unknown"');
    });
  });
});
