import type { Mock } from "vitest";
import { Context, type KernelContext } from "./context";
import { ExecutionTracker } from "./execution-tracker";
import { Telemetry } from "./telemetry";

// Mock Telemetry
vi.mock("./telemetry", () => ({
  Telemetry: {
    startSpan: vi.fn(() => ({
      setAttribute: vi.fn(),
      recordError: vi.fn(),
      end: vi.fn(),
    })),
    getHistogram: vi.fn(() => ({
      record: vi.fn(),
    })),
    getCounter: vi.fn(() => ({
      add: vi.fn(),
    })),
  },
}));

describe("ExecutionTracker", () => {
  let ctx: KernelContext;

  beforeEach(() => {
    ctx = Context.create();
    vi.clearAllMocks();

    // Restore mock implementations after clearing
    (Telemetry.startSpan as Mock).mockImplementation(() => ({
      setAttribute: vi.fn(),
      recordError: vi.fn(),
      end: vi.fn(),
    }));
    (Telemetry.getHistogram as Mock).mockImplementation(() => ({
      record: vi.fn(),
    }));
    (Telemetry.getCounter as Mock).mockImplementation(() => ({
      add: vi.fn(),
    }));
  });

  // Helper to run tests within a context
  const runInContext = <T>(fn: () => Promise<T>): Promise<T> => {
    return Context.run(ctx, fn);
  };

  describe("basic tracking", () => {
    it("should track a procedure execution", async () => {
      const result = await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test-proc" }, async (node) => {
          expect(node).toBeDefined();
          expect(node.name).toBe("test-proc");
          expect(node.status).toBe("running");
          return "result";
        });
      });

      expect(result).toBe("result");
      expect(ctx.procedureGraph).toBeDefined();
      expect(ctx.procedureGraph!.getCount()).toBe(1);
    });

    it("should initialize ProcedureGraph if not present", async () => {
      expect(ctx.procedureGraph).toBeUndefined();

      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async () => "result");
      });

      expect(ctx.procedureGraph).toBeDefined();
    });

    it("should track nested procedures", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "parent" }, async (parentNode) => {
          // Inside forked context, use Context.get() to get current context
          const parentCtx = Context.get();
          expect(parentCtx.procedurePid).toBe(parentNode.pid);

          await ExecutionTracker.track(parentCtx, { name: "child" }, async (childNode) => {
            const childCtx = Context.get();
            expect(childNode.parentPid).toBe(parentNode.pid);
            expect(childCtx.procedurePid).toBe(childNode.pid);
            return "child-result";
          });

          // After child completes, parent context is still active
          expect(Context.get().procedurePid).toBe(parentNode.pid);
          return "parent-result";
        });
      });

      expect(ctx.procedureGraph!.getCount()).toBe(2);
      const children = ctx.procedureGraph!.getChildren(ctx.procedureGraph!.getAllNodes()[0].pid);
      expect(children.length).toBeGreaterThan(0);
    });
  });

  describe("metrics tracking", () => {
    it("should track metrics written to ctx.metrics", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async (node) => {
          // Use Context.get() to access the forked context's metrics proxy
          const forkedCtx = Context.get();
          forkedCtx.metrics!["usage.inputTokens"] = 100;
          forkedCtx.metrics!["usage.outputTokens"] = 50;

          expect(node.getMetric("usage.inputTokens")).toBe(100);
          expect(node.getMetric("usage.outputTokens")).toBe(50);

          return "result";
        });
      });

      // Metrics should be in the node
      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.getMetric("usage.inputTokens")).toBe(100);
      expect(node.getMetric("usage.outputTokens")).toBe(50);
    });

    it("should accumulate metrics when adding multiple times", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async (node) => {
          // Use Context.get() to access the forked context's metrics proxy
          const forkedCtx = Context.get();
          forkedCtx.metrics!["usage.inputTokens"] = 100;
          forkedCtx.metrics!["usage.inputTokens"] = 150; // Overwrite

          // Proxy tracks delta: first set adds 100, second set adds 50 (150-100) = 150 total
          expect(node.getMetric("usage.inputTokens")).toBe(150);

          return "result";
        });
      });
    });

    it("should propagate metrics to parent on completion", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "parent" }, async (parentNode) => {
          const parentCtx = Context.get();

          // Parent adds its own metrics
          parentCtx.metrics!["usage.inputTokens"] = 50;

          await ExecutionTracker.track(parentCtx, { name: "child" }, async (_childNode) => {
            // Use Context.get() to access the child's forked context
            const childCtx = Context.get();
            childCtx.metrics!["usage.inputTokens"] = 100;
            return "child-result";
          });

          // After child completes, verify child has metrics
          const childNode = parentCtx.procedureGraph!.getChildNodes(parentNode.pid)[0];
          expect(childNode).toBeDefined();
          expect(childNode!.getMetric("usage.inputTokens")).toBe(100);

          // Parent should have its own metrics PLUS child's metrics propagated
          // Parent: 50 + Child propagated: 100 = 150
          expect(parentNode.getMetric("usage.inputTokens")).toBe(150);

          return "parent-result";
        });
      });
    });
  });

  describe("telemetry integration", () => {
    it("should create telemetry span", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(
          ctx,
          { name: "test-proc", metadata: { userId: "123" } },
          async () => "result",
        );
      });

      expect(Telemetry.startSpan).toHaveBeenCalledWith("test-proc");
    });

    it("should send metrics to telemetry on completion", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async (_node) => {
          // Use Context.get() to access the forked context's metrics proxy
          const forkedCtx = Context.get();
          forkedCtx.metrics!["usage.inputTokens"] = 100;
          return "result";
        });
      });

      expect(Telemetry.getHistogram).toHaveBeenCalledWith("procedure.usage.inputTokens");
    });
  });

  describe("error handling", () => {
    it("should track failed procedures", async () => {
      const error = new Error("Test error");

      await expect(
        runInContext(async () => {
          return ExecutionTracker.track(ctx, { name: "test" }, async () => {
            throw error;
          });
        }),
      ).rejects.toThrow("Test error");

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.status).toBe("failed");
      expect(node.error).toBe(error);
    });

    it("should track aborted procedures", async () => {
      ctx.signal = AbortSignal.abort();

      await expect(
        runInContext(async () => {
          return ExecutionTracker.track(ctx, { name: "test" }, async () => "result");
        }),
      ).rejects.toThrow("Operation aborted");

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.status).toBe("cancelled");
    });
  });

  describe("execution boundary detection", () => {
    it("should mark root procedure as execution boundary", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "model:generate" }, async (node) => {
          expect(node.isExecutionBoundary).toBe(true);
          expect(node.executionId).toBe(node.pid);
          expect(node.executionType).toBe("model");
          return "result";
        });
      });

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.isExecutionBoundary).toBe(true);
      expect(node.executionType).toBe("model");
    });

    it("should derive executionType from procedure name prefix", async () => {
      await runInContext(async () => {
        await ExecutionTracker.track(ctx, { name: "tool:search" }, async (node) => {
          expect(node.executionType).toBe("tool");
          return "result";
        });
      });

      // Create fresh context for second test
      const ctx2 = Context.create();
      await Context.run(ctx2, async () => {
        await ExecutionTracker.track(ctx2, { name: "engine:stream" }, async (node) => {
          expect(node.executionType).toBe("engine");
          return "result";
        });
      });
    });

    it("should use procedure name as executionType when no colon present", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "anonymous" }, async (node) => {
          expect(node.executionType).toBe("anonymous");
          return "result";
        });
      });
    });

    it("should inherit executionId from parent (not create new boundary)", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "engine:stream" }, async (parentNode) => {
          const parentCtx = Context.get();

          await ExecutionTracker.track(parentCtx, { name: "model:generate" }, async (childNode) => {
            // Child should inherit parent's executionId
            expect(childNode.executionId).toBe(parentNode.executionId);
            // Child should NOT be a boundary
            expect(childNode.isExecutionBoundary).toBe(false);
            // Child should not have executionType set (only boundaries have it)
            expect(childNode.executionType).toBeUndefined();
            return "child-result";
          });

          return "parent-result";
        });
      });

      const nodes = ctx.procedureGraph!.getAllNodes();
      expect(nodes.length).toBe(2);

      // All nodes should share the same executionId
      const executionIds = new Set(nodes.map((n) => n.executionId));
      expect(executionIds.size).toBe(1);

      // Only parent should be a boundary
      const boundaries = nodes.filter((n) => n.isExecutionBoundary);
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].name).toBe("engine:stream");
    });

    it("should propagate executionId through deeply nested procedures", async () => {
      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "engine:execute" }, async (rootNode) => {
          const ctx1 = Context.get();

          await ExecutionTracker.track(ctx1, { name: "compile:tick" }, async (tickNode) => {
            const ctx2 = Context.get();

            await ExecutionTracker.track(ctx2, { name: "model:generate" }, async (modelNode) => {
              const ctx3 = Context.get();

              await ExecutionTracker.track(ctx3, { name: "tool:execute" }, async (toolNode) => {
                // All should share the same executionId
                expect(toolNode.executionId).toBe(rootNode.executionId);
                expect(modelNode.executionId).toBe(rootNode.executionId);
                expect(tickNode.executionId).toBe(rootNode.executionId);
                return "tool-result";
              });

              return "model-result";
            });

            return "tick-result";
          });

          return "engine-result";
        });
      });

      const nodes = ctx.procedureGraph!.getAllNodes();
      expect(nodes.length).toBe(4);

      // All should share same executionId
      const executionIds = new Set(nodes.map((n) => n.executionId));
      expect(executionIds.size).toBe(1);
    });

    it("should allow explicit executionId to be provided", async () => {
      const explicitExecutionId = "explicit-exec-123";

      await runInContext(async () => {
        return ExecutionTracker.track(
          ctx,
          { name: "engine:stream", executionId: explicitExecutionId },
          async (node) => {
            expect(node.executionId).toBe(explicitExecutionId);
            expect(node.isExecutionBoundary).toBe(true);
            return "result";
          },
        );
      });

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.executionId).toBe(explicitExecutionId);
    });

    it("should use executionHandle.pid from context when available", async () => {
      const handlePid = "handle-pid-456";

      // Simulate Engine setting executionHandle on context (like handleFactory does)
      ctx.executionHandle = { pid: handlePid } as any;

      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "engine:stream" }, async (node) => {
          // Should use the handle's pid as executionId
          expect(node.executionId).toBe(handlePid);
          expect(node.isExecutionBoundary).toBe(true);
          return "result";
        });
      });

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.executionId).toBe(handlePid);
    });

    it("should prefer explicit executionId over executionHandle.pid", async () => {
      const explicitId = "explicit-id";
      const handlePid = "handle-pid";

      ctx.executionHandle = { pid: handlePid } as any;

      await runInContext(async () => {
        return ExecutionTracker.track(
          ctx,
          { name: "engine:stream", executionId: explicitId },
          async (node) => {
            // Explicit executionId takes priority
            expect(node.executionId).toBe(explicitId);
            return "result";
          },
        );
      });

      const node = ctx.procedureGraph!.getAllNodes()[0];
      expect(node.executionId).toBe(explicitId);
    });

    it("should include execution info in procedure:start event", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = Context.subscribeGlobal((event) => {
        events.push(event as { type: string; payload: Record<string, unknown> });
      });

      try {
        await runInContext(async () => {
          return ExecutionTracker.track(ctx, { name: "model:generate" }, async () => "result");
        });

        const startEvent = events.find((e) => e.type === "procedure:start");
        expect(startEvent).toBeDefined();
        expect(startEvent!.payload.executionId).toBeDefined();
        expect(startEvent!.payload.isExecutionBoundary).toBe(true);
        expect(startEvent!.payload.executionType).toBe("model");
      } finally {
        unsubscribe();
      }
    });

    it("should include executionId in procedure:end event", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = Context.subscribeGlobal((event) => {
        events.push(event as { type: string; payload: Record<string, unknown> });
      });

      try {
        await runInContext(async () => {
          return ExecutionTracker.track(ctx, { name: "test:proc" }, async () => "result");
        });

        const endEvent = events.find((e) => e.type === "procedure:end");
        expect(endEvent).toBeDefined();
        expect(endEvent!.payload.executionId).toBeDefined();
      } finally {
        unsubscribe();
      }
    });

    it("should include executionId in procedure:error event", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = Context.subscribeGlobal((event) => {
        events.push(event as { type: string; payload: Record<string, unknown> });
      });

      try {
        await expect(
          runInContext(async () => {
            return ExecutionTracker.track(ctx, { name: "test:proc" }, async () => {
              throw new Error("Test error");
            });
          }),
        ).rejects.toThrow("Test error");

        const errorEvent = events.find((e) => e.type === "procedure:error");
        expect(errorEvent).toBeDefined();
        expect(errorEvent!.payload.executionId).toBeDefined();
      } finally {
        unsubscribe();
      }
    });
  });

  describe("context isolation", () => {
    it("should have forked context with procedurePid inside callback", async () => {
      const initialPid = ctx.procedurePid;

      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async () => {
          // Inside forked context, procedurePid is set
          const forkedCtx = Context.get();
          expect(forkedCtx.procedurePid).toBeDefined();
          expect(forkedCtx.procedurePid).not.toBe(initialPid);
          return "result";
        });
      });

      // Original context is unchanged (isolation, not restoration)
      expect(ctx.procedurePid).toBe(initialPid);
    });

    it("should isolate metrics to forked context", async () => {
      ctx.metrics = { existing: 50 };
      const originalMetrics = { ...ctx.metrics };

      await runInContext(async () => {
        return ExecutionTracker.track(ctx, { name: "test" }, async () => {
          // Forked context has its own metrics proxy
          const forkedCtx = Context.get();
          forkedCtx.metrics!["new"] = 100;
          return "result";
        });
      });

      // Original metrics are unchanged (isolation, not restoration)
      expect(ctx.metrics).toEqual(originalMetrics);
    });
  });
});
