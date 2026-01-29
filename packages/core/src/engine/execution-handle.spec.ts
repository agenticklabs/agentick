import { ExecutionHandleImpl } from "./execution-handle";
import { generatePid } from "./execution-types";
import type { COMInput } from "../com/types";
import type { StreamEvent } from "./engine-events";

describe("ExecutionHandleImpl", () => {
  let handle: ExecutionHandleImpl;

  beforeEach(() => {
    const pid = generatePid("test");
    handle = new ExecutionHandleImpl(pid, pid, "root");
  });

  afterEach(async () => {
    // Clean up handle if still running
    // Catch promise rejections to prevent uncaught exceptions
    if (handle.status === "running") {
      // Set up error handler before cancelling
      const completionPromise = handle.waitForCompletion().catch(() => {
        // Expected rejection - prevents uncaught exception
      });

      handle.cancel();

      // Wait for rejection to be handled
      await completionPromise;
    }
  });

  describe("initialization", () => {
    it("should initialize with correct properties", () => {
      const pid = generatePid("test");
      const rootPid = generatePid("root");
      const handle = new ExecutionHandleImpl(pid, rootPid, "child", "parent-pid");

      expect(handle.pid).toBe(pid);
      expect(handle.rootPid).toBe(rootPid);
      expect(handle.parentPid).toBe("parent-pid");
      expect(handle.type).toBe("child");
      expect(handle.status).toBe("running");
      expect(handle.startedAt).toBeInstanceOf(Date);
      expect(handle.completedAt).toBeUndefined();
    });

    it("should initialize root execution correctly", () => {
      const pid = generatePid("root");
      const handle = new ExecutionHandleImpl(pid, pid, "root");

      expect(handle.pid).toBe(pid);
      expect(handle.rootPid).toBe(pid);
      expect(handle.parentPid).toBeUndefined();
      expect(handle.type).toBe("root");
    });
  });

  describe("completion", () => {
    it("should complete execution successfully", async () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      handle.complete(result);

      expect(handle.status).toBe("completed");
      expect(handle.completedAt).toBeDefined();
      expect(handle.getResult()).toBe(result);

      const completedResult = await handle.waitForCompletion();
      expect(completedResult).toBe(result);
    });

    it("should not complete if already completed", () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      handle.complete(result);
      const completedAt = handle.completedAt;

      // Try to complete again
      handle.complete({
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      });

      expect(handle.completedAt).toBe(completedAt);
    });

    it("should not complete if already failed", async () => {
      const error = new Error("Test error");

      // Set up promise handler before calling fail
      const completionPromise = handle.waitForCompletion().catch(() => {
        // Expected rejection
      });

      handle.fail(error);
      await completionPromise;

      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      handle.complete(result);

      expect(handle.status).toBe("failed");
      expect(handle.getResult()).toBeUndefined();
    });
  });

  describe("failure", () => {
    it("should fail execution with error", async () => {
      const error = new Error("Test error");

      handle.fail(error);

      expect(handle.status).toBe("failed");
      expect(handle.completedAt).toBeDefined();

      await expect(handle.waitForCompletion()).rejects.toThrow("Test error");
    });

    it("should not fail if already completed", () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      handle.complete(result);
      const completedAt = handle.completedAt;

      handle.fail(new Error("Should not fail"));

      expect(handle.status).toBe("completed");
      expect(handle.completedAt).toBe(completedAt);
    });
  });

  describe("cancellation", () => {
    it("should cancel execution", async () => {
      const controller = new AbortController();
      handle.setCancelController(controller);

      // Set up promise handler before cancelling
      const completionPromise = handle.waitForCompletion().catch(() => {
        // Expected rejection
      });

      handle.cancel();
      await completionPromise;

      expect(handle.status).toBe("cancelled");
      expect(handle.completedAt).toBeDefined();
      expect(controller.signal.aborted).toBe(true);
    });

    it("should reject completion promise on cancel", async () => {
      // Set up promise before cancelling to catch the rejection
      const completionPromise = handle.waitForCompletion();

      handle.cancel();

      await expect(completionPromise).rejects.toThrow("Execution cancelled");
    });

    it("should not cancel if already completed", () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      handle.complete(result);
      const controller = new AbortController();
      handle.setCancelController(controller);

      handle.cancel();

      expect(handle.status).toBe("completed");
      expect(controller.signal.aborted).toBe(false);
    });
  });

  describe("waitForCompletion", () => {
    it("should wait for completion", async () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      // Complete after a short delay
      setTimeout(() => {
        handle.complete(result);
      }, 10);

      const completedResult = await handle.waitForCompletion();
      expect(completedResult).toBe(result);
    });

    it("should timeout if execution does not complete", async () => {
      await expect(handle.waitForCompletion({ timeout: 50 })).rejects.toThrow(/timed out/);
    });

    it("should not timeout if execution completes quickly", async () => {
      const result: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      setTimeout(() => {
        handle.complete(result);
      }, 10);

      const completedResult = await handle.waitForCompletion({ timeout: 100 });
      expect(completedResult).toBe(result);
    });
  });

  describe("stream", () => {
    it("should stream execution events", async () => {
      const events: StreamEvent[] = [
        {
          type: "execution_start",
          id: "evt_1",
          tick: 1,
          timestamp: new Date().toISOString(),
          executionId: "test-exec",
          metadata: { threadId: "test-thread" },
        },
        { type: "tick_start", id: "evt_2", tick: 1, timestamp: new Date().toISOString() },
        {
          type: "execution_end",
          id: "evt_3",
          tick: 1,
          executionId: "test-exec",
          metadata: { threadId: "test-thread" },
          output: {
            timeline: [],
            sections: {},
            tools: [],
            metadata: {},
            ephemeral: [],
            system: [],
          },
          timestamp: new Date().toISOString(),
        },
      ];

      async function* eventGenerator() {
        for (const event of events) {
          yield event;
        }
      }

      handle.setStreamIterator(eventGenerator());

      const streamedEvents: StreamEvent[] = [];
      for await (const event of handle.stream()) {
        streamedEvents.push(event);
      }

      expect(streamedEvents).toEqual(events);
    });

    it("should throw if stream iterator not set", () => {
      expect(() => handle.stream()).toThrow("Stream iterator not set");
    });
  });

  describe("metrics", () => {
    it("should get execution metrics", () => {
      const metrics = handle.getMetrics();

      expect(metrics.pid).toBe(handle.pid);
      expect(metrics.rootPid).toBe(handle.rootPid);
      expect(metrics.type).toBe(handle.type);
      expect(metrics.status).toBe("running");
      expect(metrics.startedAt).toBe(handle.startedAt);
      expect(metrics.duration).toBeGreaterThanOrEqual(0);
      expect(metrics.tickCount).toBe(0);
    });

    it("should include tick count in metrics", () => {
      handle.incrementTick();
      handle.incrementTick();

      const metrics = handle.getMetrics();
      expect(metrics.tickCount).toBe(2);
    });

    it("should include error in metrics when failed", async () => {
      const error = new Error("Test error");

      // Set up promise handler before calling fail
      const completionPromise = handle.waitForCompletion().catch(() => {
        // Expected rejection
      });

      handle.fail(error);

      // Wait for rejection to be handled
      await completionPromise;

      const metrics = handle.getMetrics();
      expect(metrics.status).toBe("failed");
      expect(metrics.error?.message).toBe("Test error");
    });

    it("should calculate duration correctly", async () => {
      const startTime = handle.startedAt.getTime();

      // Wait a bit
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          const duration = handle.getDuration();
          const expectedDuration = Date.now() - startTime;

          // Allow some tolerance for timing
          expect(duration).toBeGreaterThanOrEqual(expectedDuration - 10);
          expect(duration).toBeLessThanOrEqual(expectedDuration + 10);

          resolve();
        }, 10);
      });
    });

    it("should calculate duration with completion time", async () => {
      const startTime = handle.startedAt.getTime();

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          handle.complete({
            timeline: [],
            sections: {},
            tools: [],
            metadata: {},
            ephemeral: [],
            system: [],
          });

          const duration = handle.getDuration();
          const expectedDuration = handle.completedAt!.getTime() - startTime;

          expect(duration).toBe(expectedDuration);
          resolve();
        }, 10);
      });
    });
  });

  describe("toState", () => {
    it("should create execution state for persistence", () => {
      handle.incrementTick();
      handle.incrementTick();

      const component = {} as any;
      const input = { timeline: [] };
      const previous: COMInput = {
        timeline: [],
        sections: {},
        tools: [],
        metadata: {},
        ephemeral: [],
        system: [],
      };

      const state = handle.toState(component, input, 2, previous);

      expect(state.pid).toBe(handle.pid);
      expect(state.rootPid).toBe(handle.rootPid);
      expect(state.type).toBe(handle.type);
      expect(state.status).toBe("running");
      expect(state.input).toBe(input);
      expect(state.component).toBe(component);
      expect(state.currentTick).toBe(2);
      expect(state.previous).toBe(previous);
      expect(state.startedAt).toBe(handle.startedAt);
    });

    it("should include error in state when failed", async () => {
      const error = new Error("Test error");

      // Set up error handler before calling fail to catch the rejection
      const completionPromise = handle.waitForCompletion().catch(() => {
        // Expected rejection - this prevents uncaught exception
      });

      handle.fail(error);

      // Wait for the rejection to be handled
      await completionPromise;

      const state = handle.toState({} as any, {}, 1);

      expect(state.status).toBe("failed");
      expect(state.error?.message).toBe("Test error");
      expect(state.error?.stack).toBeDefined();
    });
  });
});
