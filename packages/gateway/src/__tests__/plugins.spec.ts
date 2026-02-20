/**
 * Gateway Plugin System Tests
 *
 * Tests the plugin lifecycle, method registration, session routing,
 * cross-plugin invocation, and gateway handle injection.
 *
 * Heavy focus on adversarial cases: double registration, ownership
 * isolation, concurrent ops, cleanup on removal, and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Context } from "@agentick/kernel";
import {
  Gateway,
  createGateway,
  method,
  type GatewayPlugin,
  type PluginContext,
} from "../index.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a trivial plugin that records lifecycle calls */
function createTestPlugin(
  id: string,
  opts?: {
    onInit?: (ctx: PluginContext) => void | Promise<void>;
    onDestroy?: () => void | Promise<void>;
  },
): GatewayPlugin & { initialized: boolean; destroyed: boolean; ctx: PluginContext | null } {
  const plugin = {
    id,
    initialized: false,
    destroyed: false,
    ctx: null as PluginContext | null,
    async initialize(ctx: PluginContext) {
      plugin.ctx = ctx;
      plugin.initialized = true;
      if (opts?.onInit) await opts.onInit(ctx);
    },
    async destroy() {
      plugin.destroyed = true;
      if (opts?.onDestroy) await opts.onDestroy();
    },
  };
  return plugin;
}

describe("Gateway Plugin System", () => {
  let gateway: Gateway;
  let app: MockApp;

  beforeEach(() => {
    app = createMockApp();
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  function createTestGateway(plugins?: GatewayPlugin[]) {
    gateway = createGateway({
      apps: { chat: app },
      defaultApp: "chat",
      embedded: true,
      plugins,
    });
    return gateway;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Plugin Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  describe("lifecycle", () => {
    it("registers a plugin and calls initialize with valid PluginContext", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("test");

      await gw.use(plugin);

      expect(plugin.initialized).toBe(true);
      expect(plugin.ctx).not.toBeNull();
      expect(plugin.ctx!.gatewayId).toBe(gw.id);
      expect(typeof plugin.ctx!.sendToSession).toBe("function");
      expect(typeof plugin.ctx!.registerMethod).toBe("function");
      expect(typeof plugin.ctx!.unregisterMethod).toBe("function");
      expect(typeof plugin.ctx!.invoke).toBe("function");
      expect(typeof plugin.ctx!.on).toBe("function");
      expect(typeof plugin.ctx!.off).toBe("function");
    });

    it("emits plugin:registered on use()", async () => {
      const gw = createTestGateway();
      const events: string[] = [];
      gw.on("plugin:registered", (e) => events.push(e.pluginId));

      await gw.use(createTestPlugin("alpha"));
      expect(events).toEqual(["alpha"]);
    });

    it("emits plugin:removed on remove()", async () => {
      const gw = createTestGateway();
      const events: string[] = [];
      gw.on("plugin:removed", (e) => events.push(e.pluginId));

      await gw.use(createTestPlugin("alpha"));
      await gw.remove("alpha");
      expect(events).toEqual(["alpha"]);
    });

    it("calls destroy() on remove()", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("test");

      await gw.use(plugin);
      expect(plugin.destroyed).toBe(false);

      await gw.remove("test");
      expect(plugin.destroyed).toBe(true);
    });

    it("calls destroy() on gateway.stop()", async () => {
      const plugin = createTestPlugin("test");
      const gw = createTestGateway([plugin]);

      // Wait for async constructor init
      await new Promise((r) => setTimeout(r, 50));
      expect(plugin.initialized).toBe(true);

      await gw.stop();
      expect(plugin.destroyed).toBe(true);
    });

    it("destroys plugins in reverse registration order on stop()", async () => {
      const order: string[] = [];
      const gw = createTestGateway();

      await gw.use(
        createTestPlugin("first", {
          onDestroy: () => {
            order.push("first");
          },
        }),
      );
      await gw.use(
        createTestPlugin("second", {
          onDestroy: () => {
            order.push("second");
          },
        }),
      );
      await gw.use(
        createTestPlugin("third", {
          onDestroy: () => {
            order.push("third");
          },
        }),
      );

      await gw.stop();
      expect(order).toEqual(["third", "second", "first"]);
    });

    it("getPlugin returns the plugin instance", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("finder");
      await gw.use(plugin);

      expect(gw.getPlugin("finder")).toBe(plugin);
    });

    it("getPlugin returns undefined for unknown id", () => {
      const gw = createTestGateway();
      expect(gw.getPlugin("nope")).toBeUndefined();
    });

    it("initializes config plugins in constructor", async () => {
      const plugin = createTestPlugin("from-config");
      createTestGateway([plugin]);

      // Constructor fires use() asynchronously
      await new Promise((r) => setTimeout(r, 50));
      expect(plugin.initialized).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Adversarial: Double Registration & Unknown Removal
  // ══════════════════════════════════════════════════════════════════════════

  describe("adversarial lifecycle", () => {
    it("throws on double use() with same id", async () => {
      const gw = createTestGateway();
      await gw.use(createTestPlugin("dup"));
      await expect(gw.use(createTestPlugin("dup"))).rejects.toThrow(
        'Plugin "dup" is already registered',
      );
    });

    it("remove() of unknown id is a no-op (no throw)", async () => {
      const gw = createTestGateway();
      await expect(gw.remove("nonexistent")).resolves.toBeUndefined();
    });

    it("can re-register after removal", async () => {
      const gw = createTestGateway();
      const p1 = createTestPlugin("recycle");
      await gw.use(p1);
      await gw.remove("recycle");

      const p2 = createTestPlugin("recycle");
      await gw.use(p2);
      expect(p2.initialized).toBe(true);
      expect(gw.getPlugin("recycle")).toBe(p2);
    });

    it("does not leave zombie entry when initialize() throws", async () => {
      const gw = createTestGateway();
      const badPlugin: GatewayPlugin = {
        id: "bad",
        async initialize() {
          throw new Error("init boom");
        },
        async destroy() {},
      };

      await expect(gw.use(badPlugin)).rejects.toThrow("init boom");

      // Plugin must NOT be in the map after failed init
      expect(gw.getPlugin("bad")).toBeUndefined();

      // Must be re-registerable (not stuck in "already registered" state)
      const goodPlugin = createTestPlugin("bad");
      await gw.use(goodPlugin);
      expect(gw.getPlugin("bad")).toBe(goodPlugin);
    });

    it("cleans up methods registered during partial init failure", async () => {
      const gw = createTestGateway();
      const badPlugin: GatewayPlugin = {
        id: "partial",
        async initialize(ctx) {
          ctx.registerMethod("partial:method", async () => "registered before crash");
          throw new Error("init boom after registering method");
        },
        async destroy() {},
      };

      await expect(gw.use(badPlugin)).rejects.toThrow("init boom");

      // The method registered during partial init must be cleaned up
      const cleanPlugin = createTestPlugin("clean");
      await gw.use(cleanPlugin);
      await expect(cleanPlugin.ctx!.invoke("partial:method", {})).rejects.toThrow("Unknown method");

      // Another plugin can now claim that path
      const reclaimer = createTestPlugin("reclaim", {
        onInit: (ctx) => {
          ctx.registerMethod("partial:method", async () => "reclaimed");
        },
      });
      await gw.use(reclaimer);
      expect(await reclaimer.ctx!.invoke("partial:method", {})).toBe("reclaimed");
    });

    it("handles stop() racing with async constructor plugin init", async () => {
      let initResolve: () => void;
      const initPromise = new Promise<void>((r) => {
        initResolve = r;
      });

      const slowPlugin: GatewayPlugin = {
        id: "slow",
        async initialize() {
          await initPromise;
        },
        async destroy() {},
      };

      const gw = createTestGateway([slowPlugin]);

      // stop() before init completes — should not deadlock or throw
      const stopPromise = gw.stop();

      // Let init complete
      initResolve!();
      await stopPromise;
    });

    it("survives a plugin that throws in destroy()", async () => {
      const gw = createTestGateway();
      const badPlugin: GatewayPlugin = {
        id: "bad-destroy",
        async initialize() {},
        async destroy() {
          throw new Error("destroy boom");
        },
      };

      await gw.use(badPlugin);
      // stop() catches destroy errors and continues
      await expect(gw.stop()).resolves.toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Method Registration
  // ══════════════════════════════════════════════════════════════════════════

  describe("method registration", () => {
    it("registers a simple method handler", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("echo", {
        onInit: (ctx) => {
          ctx.registerMethod("echo:ping", async (params) => ({ pong: params }));
        },
      });

      await gw.use(plugin);
      const result = await plugin.ctx!.invoke("echo:ping", { msg: "hello" });
      expect(result).toEqual({ pong: { msg: "hello" } });
    });

    it("rejects registration of built-in method names", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("hijack", {
        onInit: (ctx) => {
          expect(() => ctx.registerMethod("send", async () => ({}))).toThrow(
            "Cannot override built-in method: send",
          );
        },
      });

      await gw.use(plugin);
    });

    it("rejects duplicate method registration", async () => {
      const gw = createTestGateway();
      const p1 = createTestPlugin("first-claim", {
        onInit: (ctx) => {
          ctx.registerMethod("shared:method", async () => "first");
        },
      });
      await gw.use(p1);

      const p2 = createTestPlugin("second-claim", {
        onInit: (ctx) => {
          expect(() => ctx.registerMethod("shared:method", async () => "second")).toThrow(
            'Method "shared:method" is already registered',
          );
        },
      });
      await gw.use(p2);
    });

    it("unregisters own methods", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("unreg", {
        onInit: (ctx) => {
          ctx.registerMethod("unreg:temp", async () => "alive");
        },
      });
      await gw.use(plugin);

      // Method works
      const result = await plugin.ctx!.invoke("unreg:temp", {});
      expect(result).toBe("alive");

      // Unregister
      plugin.ctx!.unregisterMethod("unreg:temp");

      // Method is gone
      await expect(plugin.ctx!.invoke("unreg:temp", {})).rejects.toThrow("Unknown method");
    });

    it("cannot unregister another plugin's methods", async () => {
      const gw = createTestGateway();

      const owner = createTestPlugin("owner", {
        onInit: (ctx) => {
          ctx.registerMethod("owner:secret", async () => "mine");
        },
      });
      await gw.use(owner);

      const thief = createTestPlugin("thief", {
        onInit: (ctx) => {
          // This should silently no-op
          ctx.unregisterMethod("owner:secret");
        },
      });
      await gw.use(thief);

      // Owner's method still works
      const result = await owner.ctx!.invoke("owner:secret", {});
      expect(result).toBe("mine");
    });

    it("registers a MethodDefinition with description", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("method-def", {
        onInit: (ctx) => {
          ctx.registerMethod(
            "method-def:fancy",
            method({
              description: "A fancy method",
              handler: async (params: any) => ({ fancy: true, ...params }),
            }),
          );
        },
      });

      await gw.use(plugin);
      const result = await plugin.ctx!.invoke("method-def:fancy", { x: 1 });
      expect(result).toEqual({ fancy: true, x: 1 });
    });

    it("cleans up methods on plugin removal", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("cleanup", {
        onInit: (ctx) => {
          ctx.registerMethod("cleanup:a", async () => "a");
          ctx.registerMethod("cleanup:b", async () => "b");
        },
      });
      await gw.use(plugin);

      // Both methods work
      expect(await plugin.ctx!.invoke("cleanup:a", {})).toBe("a");
      expect(await plugin.ctx!.invoke("cleanup:b", {})).toBe("b");

      await gw.remove("cleanup");

      // A new plugin can now claim those method paths
      const reclaimer = createTestPlugin("reclaim", {
        onInit: (ctx) => {
          ctx.registerMethod("cleanup:a", async () => "reclaimed");
        },
      });
      await gw.use(reclaimer);
      expect(await reclaimer.ctx!.invoke("cleanup:a", {})).toBe("reclaimed");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cross-Plugin Invocation
  // ══════════════════════════════════════════════════════════════════════════

  describe("cross-plugin invocation", () => {
    it("plugin A can invoke plugin B's methods", async () => {
      const gw = createTestGateway();

      const provider = createTestPlugin("provider", {
        onInit: (ctx) => {
          ctx.registerMethod("provider:compute", async (params: any) => ({
            result: (params.x ?? 0) * 2,
          }));
        },
      });
      await gw.use(provider);

      const consumer = createTestPlugin("consumer");
      await gw.use(consumer);

      const result = await consumer.ctx!.invoke("provider:compute", { x: 21 });
      expect(result).toEqual({ result: 42 });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Event Subscription
  // ══════════════════════════════════════════════════════════════════════════

  describe("event subscription", () => {
    it("plugin can subscribe to gateway events via on/off", async () => {
      const gw = createTestGateway();
      const events: string[] = [];

      const plugin = createTestPlugin("listener", {
        onInit: (ctx) => {
          ctx.on("plugin:registered", (e) => events.push(e.pluginId));
        },
      });
      await gw.use(plugin);

      // Register another plugin — listener should see it
      await gw.use(createTestPlugin("newcomer"));
      expect(events).toContain("newcomer");
    });

    it("plugin can unsubscribe from events", async () => {
      const gw = createTestGateway();
      const events: string[] = [];

      const handler = (e: { pluginId: string }) => events.push(e.pluginId);
      const plugin = createTestPlugin("unsub-test", {
        onInit: (ctx) => {
          ctx.on("plugin:registered", handler);
        },
      });
      await gw.use(plugin);

      // Should see this
      await gw.use(createTestPlugin("seen"));
      expect(events).toContain("seen");

      // Unsubscribe
      plugin.ctx!.off("plugin:registered", handler);

      // Should NOT see this
      await gw.use(createTestPlugin("unseen"));
      expect(events).not.toContain("unseen");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // sendToSession
  // ══════════════════════════════════════════════════════════════════════════

  describe("sendToSession", () => {
    it("returns an AsyncIterable<StreamEvent>", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("sender");
      await gw.use(plugin);

      const result = await plugin.ctx!.sendToSession("chat:test", {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      // Result should be async-iterable (the session execution handle)
      expect(result).toBeDefined();
      expect(Symbol.asyncIterator in result).toBe(true);

      // Verify the session was actually created
      const session = await gw.session("chat:test");
      expect(session).toBeDefined();
    });

    it("emits session:message event when sending", async () => {
      const gw = createTestGateway();
      const events: any[] = [];
      gw.on("session:message", (e) => events.push(e));

      const plugin = createTestPlugin("emitter");
      await gw.use(plugin);

      await plugin.ctx!.sendToSession("chat:msg-test", {
        messages: [{ role: "user", content: [{ type: "text", text: "tracked" }] }],
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].role).toBe("user");
    });

    it("returned iterable yields stream events", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("stream-consumer");
      await gw.use(plugin);

      const handle = await plugin.ctx!.sendToSession("chat:stream", {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      // Iterate the events — should complete without error
      const events: any[] = [];
      for await (const event of handle) {
        events.push(event);
      }

      // MockApp produces at least some events (content from default response)
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // respondToConfirmation
  // ══════════════════════════════════════════════════════════════════════════

  describe("respondToConfirmation", () => {
    it("is a function on the plugin context", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("confirm-test");
      await gw.use(plugin);

      expect(typeof plugin.ctx!.respondToConfirmation).toBe("function");
    });

    it("publishes to tool_confirmation channel without throwing", async () => {
      const gw = createTestGateway();
      const plugin = createTestPlugin("confirm-publish");
      await gw.use(plugin);

      // This creates the session so the channel exists
      await plugin.ctx!.sendToSession("chat:confirm-test", {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });

      // Should not throw — publishes to the session's channel
      await expect(
        plugin.ctx!.respondToConfirmation("chat:confirm-test", "call-123", {
          approved: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Gateway Handle Injection
  // ══════════════════════════════════════════════════════════════════════════

  describe("gateway handle injection", () => {
    it("injects gateway handle into session's ALS context", async () => {
      const gw = createTestGateway();

      // Register a method we can invoke from inside a session
      const plugin = createTestPlugin("handle-test", {
        onInit: (ctx) => {
          ctx.registerMethod("handle-test:echo", async (params) => ({ echo: params }));
        },
      });
      await gw.use(plugin);

      // Get a session through the gateway — this should inject the handle
      const session = await gw.session("test-session");
      expect(session).toBeDefined();

      // The gateway handle is on metadata.gateway. We can verify it exists
      // by checking the session was created (the handle is bound at creation time).
      // Full end-to-end verification (tool handler calls gateway.invoke) requires
      // a real app with tools — covered by integration tests.
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Concurrent Operations
  // ══════════════════════════════════════════════════════════════════════════

  describe("concurrent operations", () => {
    it("handles multiple plugins registering concurrently", async () => {
      const gw = createTestGateway();

      const plugins = Array.from({ length: 5 }, (_, i) =>
        createTestPlugin(`concurrent-${i}`, {
          onInit: (ctx) => {
            ctx.registerMethod(`concurrent-${i}:echo`, async (p) => p);
          },
        }),
      );

      // Register all concurrently
      await Promise.all(plugins.map((p) => gw.use(p)));

      // All should be registered and working
      for (let i = 0; i < 5; i++) {
        const result = await plugins[i]!.ctx!.invoke(`concurrent-${i}:echo`, { n: i });
        expect(result).toEqual({ n: i });
      }
    });

    it("handles concurrent invoke calls", async () => {
      const gw = createTestGateway();
      let counter = 0;

      const plugin = createTestPlugin("counter", {
        onInit: (ctx) => {
          ctx.registerMethod("counter:inc", async () => {
            counter++;
            return { count: counter };
          });
        },
      });
      await gw.use(plugin);

      // Fire 10 concurrent invocations
      const results = await Promise.all(
        Array.from({ length: 10 }, () => plugin.ctx!.invoke("counter:inc", {})),
      );

      // All should complete and counter should reach 10
      expect(counter).toBe(10);
      expect(results).toHaveLength(10);
    });

    it("handles registration and invocation interleaved", async () => {
      const gw = createTestGateway();

      const p1 = createTestPlugin("early", {
        onInit: (ctx) => {
          ctx.registerMethod("early:ready", async () => "yes");
        },
      });
      await gw.use(p1);

      // Invoke p1's method while p2 registers
      const [invokeResult] = await Promise.all([
        p1.ctx!.invoke("early:ready", {}),
        gw.use(
          createTestPlugin("late", {
            onInit: (ctx) => {
              ctx.registerMethod("late:ready", async () => "also yes");
            },
          }),
        ),
      ]);

      expect(invokeResult).toBe("yes");
    });
  });
});
