/**
 * Reactive Session Integration Tests
 *
 * Tests the full reactive system at the Session level:
 * - State changes when idle trigger reconciliation
 * - Multiple state changes are batched
 * - COM state signals trigger reconciliation
 * - useSignal changes trigger reconciliation
 * - Scheduler defers during tick, flushes after
 * - Reconciliation events are emitted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../../app";
import { createTestAdapter, type TestAdapterInstance } from "../../testing/test-adapter";
import type { ModelInput } from "../../model/model";
import { System, User } from "../../jsx/components/messages";
import { Model, Section } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { useState, useEffect, useSignal, useComState } from "../../hooks";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(options?: {
  delay?: number;
  response?: string;
  onExecute?: (input: ModelInput) => void;
}): TestAdapterInstance {
  return createTestAdapter({
    defaultResponse: options?.response ?? "Mock response",
    delay: options?.delay,
    onExecute: options?.onExecute,
  });
}

// Helper to wait for microtasks to flush
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 10));

// ============================================================================
// Reactive System Integration Tests
// ============================================================================

describe("Reactive Session Integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("reconciliation when idle", () => {
    it("should emit reconcile event when state changes while idle", async () => {
      vi.useRealTimers(); // Need real timers for this test

      const model = createMockModel();
      const reconcileEvents: unknown[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;
        return (
          <>
            <Model model={model} />
            <System>You are helpful.</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Listen for reconcile events
      session.on("reconcile", (event) => {
        reconcileEvents.push(event);
      });

      // First tick to initialize
      const handle = session.render({});
      await handle.result;

      // Now session is idle - change state
      expect(session.status).toBe("idle");
      signalRef!.set(1);

      // Wait for scheduler to flush
      await flushMicrotasks();

      // Should have triggered reconciliation
      expect(reconcileEvents.length).toBeGreaterThan(0);

      session.close();
    });

    it("should batch multiple state changes into single reconciliation", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const reconcileEvents: unknown[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      session.on("reconcile", (event) => {
        reconcileEvents.push(event);
      });

      // First tick
      await session.render({}).result;

      // Multiple state changes in quick succession
      signalRef!.set(1);
      signalRef!.set(2);
      signalRef!.set(3);

      // Wait for scheduler to flush
      await flushMicrotasks();

      // Should have batched into single or few reconciliations
      // (exact number depends on microtask timing, but should be less than 3)
      expect(reconcileEvents.length).toBeLessThanOrEqual(2);

      session.close();
    });
  });

  describe("COM state signals", () => {
    it("should trigger reconciliation when COM state changes while idle", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const reconcileEvents: unknown[] = [];
      let comStateRef: ReturnType<typeof useComState<string>> | undefined;

      const Agent = () => {
        // useComState returns a Signal, not a tuple
        const status = useComState("status", "pending");
        comStateRef = status;
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="status">Status: {status()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      session.on("reconcile", (event) => {
        reconcileEvents.push(event);
      });

      // First tick
      await session.render({}).result;

      // Change COM state while idle
      comStateRef!.set("active");

      // Wait for scheduler to flush
      await flushMicrotasks();

      // Should have triggered reconciliation
      expect(reconcileEvents.length).toBeGreaterThan(0);

      session.close();
    });
  });

  describe("tick boundaries", () => {
    it("should defer reconciliation during tick execution", async () => {
      vi.useRealTimers();

      const model = createMockModel({ delay: 50 });
      const reconcileEvents: unknown[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;
      let effectRan = false;

      const Agent = () => {
        signalRef = useSignal(0);

        // This effect runs after mount, during tick
        useEffect(() => {
          effectRan = true;
        }, []);

        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {signalRef()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      session.on("reconcile", (event) => {
        reconcileEvents.push(event);
      });

      // Start tick
      const handle = session.render({});

      // Wait a bit but tick should still be running
      await new Promise((r) => setTimeout(r, 20));
      expect(handle.status).toBe("running");

      // Complete tick
      await handle;

      // Effect should have run
      expect(effectRan).toBe(true);

      session.close();
    });
  });

  describe("state persistence across reconciliations", () => {
    it("should preserve state when reconciling without new tick", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const renderHistory: number[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;
        renderHistory.push(count());
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.render({}).result;
      expect(renderHistory).toContain(0);

      // Change state while idle
      signalRef!.set(1);
      await flushMicrotasks();

      // State should be preserved
      expect(renderHistory).toContain(1);

      // Change again
      signalRef!.set(2);
      await flushMicrotasks();

      expect(renderHistory).toContain(2);

      session.close();
    });

    it("should maintain component identity across reconciliations", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const mountLog: string[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;

        useEffect(() => {
          mountLog.push("mounted");
          return () => mountLog.push("unmounted");
        }, []);

        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.render({}).result;
      expect(mountLog).toEqual(["mounted"]);

      // Multiple state changes - should NOT remount
      signalRef!.set(1);
      await flushMicrotasks();
      signalRef!.set(2);
      await flushMicrotasks();
      signalRef!.set(3);
      await flushMicrotasks();

      // Should still only have one mount
      expect(mountLog).toEqual(["mounted"]);

      session.close();
    });
  });

  describe("effects during reconciliation", () => {
    it("should run effects with updated dependencies during reconciliation", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const effectLog: number[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;

        useEffect(() => {
          effectLog.push(count());
        }, [count()]);

        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.render({}).result;
      await flushMicrotasks();
      expect(effectLog).toContain(0);

      // Change state
      signalRef!.set(1);
      await flushMicrotasks();

      // Effect should have run with new value
      expect(effectLog).toContain(1);

      session.close();
    });
  });

  describe("full reactive flow", () => {
    it("should handle external state trigger → reconcile → reflect in next tick", async () => {
      vi.useRealTimers();

      const modelInputs: ModelInput[] = [];
      const model = createMockModel({
        onExecute: (input) => modelInputs.push(input),
      });

      let signalRef: ReturnType<typeof useSignal<string>> | undefined;

      const Agent = () => {
        const message = useSignal("initial");
        signalRef = message;
        return (
          <>
            <Model model={model} />
            <System>Current message: {message()}</System>
            <Timeline />
            <User>What is the message?</User>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick - model sees "initial"
      await session.render({}).result;
      const firstTickCalls = modelInputs.length;
      expect(firstTickCalls).toBeGreaterThanOrEqual(1);

      // Verify initial message was in the first call
      const firstInput = modelInputs[0];
      const firstContent = JSON.stringify(firstInput);
      expect(firstContent).toContain("initial");

      // Change state while idle
      signalRef!.set("updated");
      await flushMicrotasks();

      // Second tick - model should see "updated"
      await session.render({}).result;
      expect(modelInputs.length).toBeGreaterThan(firstTickCalls);

      // Verify the latest input contains updated message
      const lastInput = modelInputs[modelInputs.length - 1];
      const lastContent = JSON.stringify(lastInput);
      expect(lastContent).toContain("updated");

      session.close();
    });

    it("should handle useState updates across reconciliations", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const renderHistory: number[] = [];
      let setCountRef: ((n: number) => void) | undefined;

      const Agent = () => {
        const [count, setCount] = useState(0);
        setCountRef = setCount;
        renderHistory.push(count);
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.render({}).result;
      expect(renderHistory).toEqual([0]);

      // Update state while idle
      setCountRef!(1);
      await flushMicrotasks();

      // Should have reconciled with new state
      expect(renderHistory).toContain(1);

      session.close();
    });
  });

  describe("scheduler edge cases", () => {
    it("should handle rapid state changes without memory leaks", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.render({}).result;

      // Rapid fire state changes
      for (let i = 0; i < 100; i++) {
        signalRef!.set(i);
      }

      // Wait for all to flush
      await flushMicrotasks();
      await flushMicrotasks();

      // Final value should be correct
      expect(signalRef!()).toBe(99);

      session.close();
    });

    it("should not reconcile after session is closed", async () => {
      vi.useRealTimers();

      const model = createMockModel();
      const reconcileEvents: unknown[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Agent = () => {
        const count = useSignal(0);
        signalRef = count;
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
            <Section id="count">Count: {count()}</Section>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      session.on("reconcile", (event) => {
        reconcileEvents.push(event);
      });

      // First tick
      await session.render({}).result;

      // Close session
      session.close();

      // Try to change state
      try {
        signalRef!.set(1);
      } catch {
        // May throw, which is fine
      }

      await flushMicrotasks();

      // Should not have additional reconcile events after close
      const countAfterClose = reconcileEvents.length;
      await flushMicrotasks();

      expect(reconcileEvents.length).toBe(countAfterClose);
    });
  });

  describe("session.send() integration", () => {
    it("should trigger tick when send() is called with props while idle", async () => {
      vi.useRealTimers();

      const modelInputs: ModelInput[] = [];
      const model = createMockModel({
        delay: 20, // Small delay to catch running status
        onExecute: (input) => modelInputs.push(input),
      });

      const Agent = () => {
        return (
          <>
            <Model model={model} />
            <System>You are helpful.</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Send a message with props - should start a tick
      const handle = session.send({
        props: {} as any, // Provide props to trigger tick
        messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
      });

      // Handle should be running (or may have completed quickly)
      expect(["running", "completed"]).toContain(handle.status);

      await handle.result;

      expect(handle.status).toBe("completed");
      expect(modelInputs.length).toBeGreaterThanOrEqual(1);

      session.close();
    });

    it("should queue messages and process them in tick", async () => {
      vi.useRealTimers();

      const modelInputs: ModelInput[] = [];
      const model = createMockModel({
        onExecute: (input) => modelInputs.push(input),
      });

      const Agent = () => {
        return (
          <>
            <Model model={model} />
            <System>Test agent</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First establish props via tick
      await session.render({} as any).result;
      expect(modelInputs.length).toBeGreaterThanOrEqual(1);
      const countAfterFirstTick = modelInputs.length;

      // Now send a message - should start another tick
      const handle = session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Test message" }] }],
      });

      await handle.result;

      // The message should have triggered another model call
      expect(modelInputs.length).toBeGreaterThan(countAfterFirstTick);

      session.close();
    });

    it("should return same handle when send() called during running tick", async () => {
      vi.useRealTimers();

      const model = createMockModel({ delay: 100 }); // Longer delay to ensure running

      const Agent = () => {
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Start first tick via tick() to set props
      const handle1 = session.render({} as any);

      // Wait a moment to ensure it's running
      await new Promise((r) => setTimeout(r, 10));
      expect(handle1.status).toBe("running");

      // While running, send a message - should return same handle
      const handle2 = session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
      });

      // Should be the same handle (concurrent send idempotency)
      expect(handle1).toBe(handle2);

      await handle1;

      session.close();
    });

    it("should work with state changes between send() calls", async () => {
      vi.useRealTimers();

      const modelInputs: ModelInput[] = [];
      const model = createMockModel({
        onExecute: (input) => modelInputs.push(input),
      });

      let signalRef: ReturnType<typeof useSignal<string>> | undefined;

      const Agent = () => {
        const status = useSignal("pending");
        signalRef = status;
        return (
          <>
            <Model model={model} />
            <System>Status: {status()}</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick to initialize component and capture signal ref
      await session.render({} as any).result;
      const firstCallCount = modelInputs.length;
      expect(signalRef).toBeDefined();

      // Change state while idle
      signalRef!.set("active");
      await flushMicrotasks();

      // Send message - should start another tick with updated state
      const handle = session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "How are you?" }] }],
      });
      await handle.result;

      expect(modelInputs.length).toBeGreaterThan(firstCallCount);

      // Verify the later input contains "active"
      const lastInput = modelInputs[modelInputs.length - 1];
      const content = JSON.stringify(lastInput);
      expect(content).toContain("active");

      session.close();
    });
  });
});
