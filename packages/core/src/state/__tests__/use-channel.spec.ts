/**
 * Tests for useChannel() and useChannelSubscription() hooks
 *
 * These hooks provide components with access to named channels for pub/sub communication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FiberCompiler } from "../../compiler/fiber-compiler";
import { COM } from "../../com/object-model";
import { jsx } from "../../jsx/jsx-runtime";
import { Section } from "../../jsx/components/primitives";
import { Channel } from "../../core/channel";
import { useChannel, useChannelSubscription, useEffect, type UseChannelResult } from "../hooks";
import type { TickState } from "../../component/component";

describe("useChannel", () => {
  let com: COM;
  let compiler: FiberCompiler;

  const createTickState = (tick = 1): TickState => ({
    tick,
    stop: vi.fn(),
    queuedMessages: [],
  });

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("without getChannel", () => {
    it("should return unavailable result when getChannel not provided", async () => {
      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("test");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      expect(result).toBeDefined();
      expect(result!.available).toBe(false);
      expect(result!.channel).toBeUndefined();
    });

    it("should warn in development when subscribe called without channel", async () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "development";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("test");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      const unsubscribe = result!.subscribe(() => {});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[useChannel] subscribe called on 'test'"),
      );
      expect(typeof unsubscribe).toBe("function");

      process.env["NODE_ENV"] = originalEnv;
    });

    it("should warn in development when publish called without channel", async () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "development";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("test");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      result!.publish({ type: "test", payload: {} });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[useChannel] publish called on 'test'"),
      );

      process.env["NODE_ENV"] = originalEnv;
    });

    it("should reject waitForResponse when channel not available", async () => {
      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("test");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      await expect(result!.waitForResponse("request-1")).rejects.toThrow(
        "Channel 'test' not available",
      );
    });
  });

  describe("with getChannel", () => {
    it("should return available result when getChannel provided", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("events");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        getChannel,
      });

      expect(result).toBeDefined();
      expect(result!.available).toBe(true);
      expect(result!.channel).toBeInstanceOf(Channel);
      expect(result!.channel?.name).toBe("events");
    });

    it("should subscribe to channel events", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("events");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        getChannel,
      });

      const handler = vi.fn();
      const unsubscribe = result!.subscribe(handler);

      // Publish an event
      result!.publish({ type: "test", payload: { value: 42 } });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "test",
          channel: "events",
          payload: { value: 42 },
        }),
      );

      // Unsubscribe and verify no more events
      unsubscribe();
      result!.publish({ type: "test2", payload: {} });

      expect(handler).toHaveBeenCalledTimes(1); // Still only 1 call
    });

    it("should publish events with correct channel name", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("my-channel");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        getChannel,
      });

      const handler = vi.fn();
      result!.subscribe(handler);

      result!.publish({ type: "status", payload: { ready: true } });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "my-channel",
          type: "status",
          payload: { ready: true },
        }),
      );
    });

    it("should handle waitForResponse", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let result: UseChannelResult | undefined;

      const Component = () => {
        result = useChannel("confirmations");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        getChannel,
      });

      // Start waiting for response
      const responsePromise = result!.waitForResponse("request-1", 5000);

      // Simulate response arriving
      setTimeout(() => {
        result!.channel!.publish({
          type: "response",
          id: "request-1",
          channel: "confirmations",
          payload: { confirmed: true },
        });
      }, 10);

      const response = await responsePromise;

      expect(response.type).toBe("response");
      expect(response.id).toBe("request-1");
      expect(response.payload).toEqual({ confirmed: true });
    });

    it("should return same channel for same name", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let result1: UseChannelResult | undefined;
      let result2: UseChannelResult | undefined;

      const Component = () => {
        result1 = useChannel("shared");
        result2 = useChannel("shared");
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        getChannel,
      });

      expect(result1!.channel).toBe(result2!.channel);
    });
  });
});

describe("useChannelSubscription", () => {
  let com: COM;
  let compiler: FiberCompiler;

  const createTickState = (tick = 1): TickState => ({
    tick,
    stop: vi.fn(),
    queuedMessages: [],
  });

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
  });

  it("should subscribe on mount when channel is available", async () => {
    const channels = new Map<string, Channel>();
    const getChannel = (name: string) => {
      if (!channels.has(name)) {
        channels.set(name, new Channel(name));
      }
      return channels.get(name)!;
    };

    const handler = vi.fn();

    const Component = () => {
      useChannelSubscription("events", handler);
      return jsx(Section, { id: "test", children: "Hello" });
    };

    // Reconcile with getChannel provided - effects run during reconciliation
    await compiler.reconcile(jsx(Component, {}), {
      tickState: createTickState(),
      getChannel,
    });

    // Wait for microtasks to complete (effects run async)
    await new Promise((r) => setTimeout(r, 10));

    // Publish an event
    const channel = getChannel("events");
    channel.publish({
      type: "test",
      channel: "events",
      payload: { message: "hello" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "test",
        payload: { message: "hello" },
      }),
    );
  });

  it("should not call handler when channel is not available", async () => {
    const handler = vi.fn();

    const Component = () => {
      useChannelSubscription("events", handler);
      return jsx(Section, { id: "test", children: "Hello" });
    };

    // No getChannel provided
    await compiler.compile(jsx(Component, {}), createTickState());

    // Handler should not be called
    expect(handler).not.toHaveBeenCalled();
  });
});
