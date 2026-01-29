/**
 * Tests for useTick() hook
 *
 * The useTick hook provides components with control over tick execution:
 * - requestTick(): Request a new tick
 * - cancelTick(): Cancel a pending tick
 * - tickStatus: Current tick status
 * - tickCount: Total ticks executed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FiberCompiler } from "../../compiler/fiber-compiler";
import { COM } from "../../com/object-model";
import { jsx } from "../../jsx/jsx-runtime";
import { Section } from "../../jsx/components/primitives";
import { useTick, type UseTickResult } from "../hooks";
import type { TickState } from "../../component/component";
import type { TickControl } from "../../compiler/types";

describe("useTick", () => {
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

  describe("without tickControl", () => {
    it("should return default values when tickControl not available", async () => {
      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      expect(result).toBeDefined();
      expect(result!.tickStatus).toBe("idle");
      expect(result!.tickCount).toBe(1); // From tickState.tick
      expect(typeof result!.requestTick).toBe("function");
      expect(typeof result!.cancelTick).toBe("function");
    });

    it("should warn in development when requestTick called without tickControl", async () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "development";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      result!.requestTick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[useTick] requestTick called but tickControl not available"),
      );

      process.env["NODE_ENV"] = originalEnv;
    });

    it("should warn in development when cancelTick called without tickControl", async () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "development";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      result!.cancelTick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[useTick] cancelTick called but tickControl not available"),
      );

      process.env["NODE_ENV"] = originalEnv;
    });

    it("should not warn in production mode", async () => {
      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      result!.requestTick();
      result!.cancelTick();

      expect(warnSpy).not.toHaveBeenCalled();

      process.env["NODE_ENV"] = originalEnv;
    });
  });

  describe("with tickControl", () => {
    it("should delegate to tickControl when available", async () => {
      const mockTickControl: TickControl = {
        requestTick: vi.fn(),
        cancelTick: vi.fn(),
        status: "pending",
        tickCount: 5,
      };

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      // Reconcile with tickControl in options
      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(5),
        tickControl: mockTickControl,
      });

      expect(result).toBeDefined();
      expect(result!.tickStatus).toBe("pending");
      expect(result!.tickCount).toBe(5);
    });

    it("should call tickControl.requestTick when requestTick is called", async () => {
      const mockTickControl: TickControl = {
        requestTick: vi.fn(),
        cancelTick: vi.fn(),
        status: "idle",
        tickCount: 1,
      };

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        tickControl: mockTickControl,
      });

      result!.requestTick();

      expect(mockTickControl.requestTick).toHaveBeenCalledTimes(1);
    });

    it("should call tickControl.cancelTick when cancelTick is called", async () => {
      const mockTickControl: TickControl = {
        requestTick: vi.fn(),
        cancelTick: vi.fn(),
        status: "pending",
        tickCount: 1,
      };

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(),
        tickControl: mockTickControl,
      });

      result!.cancelTick();

      expect(mockTickControl.cancelTick).toHaveBeenCalledTimes(1);
    });
  });

  describe("tickCount behavior", () => {
    it("should use tickState.tick when tickControl not available", async () => {
      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.compile(jsx(Component, {}), createTickState(7));

      expect(result!.tickCount).toBe(7);
    });

    it("should use tickControl.tickCount when available", async () => {
      const mockTickControl: TickControl = {
        requestTick: vi.fn(),
        cancelTick: vi.fn(),
        status: "idle",
        tickCount: 42,
      };

      let result: UseTickResult | undefined;

      const Component = () => {
        result = useTick();
        return jsx(Section, { id: "test", children: "Hello" });
      };

      // Note: tickState.tick is 3, but tickControl.tickCount is 42
      await compiler.reconcile(jsx(Component, {}), {
        tickState: createTickState(3),
        tickControl: mockTickControl,
      });

      expect(result!.tickCount).toBe(42);
    });
  });

  describe("status values", () => {
    it.each(["idle", "running", "pending"] as const)(
      "should return '%s' status from tickControl",
      async (status) => {
        const mockTickControl: TickControl = {
          requestTick: vi.fn(),
          cancelTick: vi.fn(),
          status,
          tickCount: 1,
        };

        let result: UseTickResult | undefined;

        const Component = () => {
          result = useTick();
          return jsx(Section, { id: "test", children: "Hello" });
        };

        await compiler.reconcile(jsx(Component, {}), {
          tickState: createTickState(),
          tickControl: mockTickControl,
        });

        expect(result!.tickStatus).toBe(status);
      },
    );
  });
});
