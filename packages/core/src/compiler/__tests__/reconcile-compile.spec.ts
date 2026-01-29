/**
 * Tests for the reconcile/compile split in FiberCompiler
 *
 * This tests the reactive model where:
 * - reconcile() updates the fiber tree and runs effects
 * - collect() reads structures from the fiber tree (no side effects)
 * - compile() is reconcile() + collect()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FiberCompiler } from "../fiber-compiler";
import { COM } from "../../com/object-model";
import { jsx, Fragment } from "../../jsx/jsx-runtime";
import { Section } from "../../jsx/components/primitives";
import { Text } from "../../jsx/components/content";
import { useState, useEffect, useSignal, useTickState } from "../../state/hooks";
import type { TickState } from "../../component/component";

describe("FiberCompiler - Reactive Model", () => {
  let com: COM;
  let compiler: FiberCompiler;

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
  });

  const createTickState = (tick = 1): TickState => ({
    tick,
    stop: vi.fn(),
    queuedMessages: [],
  });

  describe("setRoot / getRoot", () => {
    it("should store and retrieve root element", () => {
      const element = jsx(Section, { id: "test", children: "Hello" });

      compiler.setRoot(element);
      expect(compiler.getRoot()).toBe(element);
    });

    it("should return null before setRoot is called", () => {
      expect(compiler.getRoot()).toBeNull();
    });
  });

  describe("reconcile()", () => {
    it("should update fiber tree without collecting structures", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });

      await compiler.reconcile(element, { tickState: createTickState() });

      // Fiber tree should exist
      expect(compiler.hasFiberTree()).toBe(true);

      // But we didn't collect structures yet
      // (can only verify indirectly by calling collect)
    });

    it("should run mount effects on first reconcile", async () => {
      const mountFn = vi.fn();

      const Component = () => {
        useEffect(() => {
          mountFn();
        }, []);
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), { tickState: createTickState() });

      expect(mountFn).toHaveBeenCalledTimes(1);
    });

    it("should run commit effects after reconcile", async () => {
      const effectFn = vi.fn();
      let renderCount = 0;

      const Component = () => {
        renderCount++;
        useEffect(() => {
          effectFn(renderCount);
        });
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), { tickState: createTickState() });
      expect(effectFn).toHaveBeenCalledWith(1);

      // Reconcile again
      await compiler.reconcile(jsx(Component, {}), { tickState: createTickState(2) });
      expect(effectFn).toHaveBeenCalledWith(2);
    });

    it("should preserve state across reconciliations", async () => {
      const values: number[] = [];

      const Component = () => {
        const count = useSignal(0);
        values.push(count());
        count.update((n) => n + 1);
        return jsx(Section, { id: "test", children: String(count()) });
      };

      await compiler.reconcile(jsx(Component, {}), { tickState: createTickState() });
      await compiler.reconcile(undefined, { tickState: createTickState(2) });
      await compiler.reconcile(undefined, { tickState: createTickState(3) });

      // Values should increment because state persists
      expect(values).toEqual([0, 1, 2]);
    });

    it("should use stored root element when not provided", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });
      compiler.setRoot(element);

      // Reconcile without passing element
      await compiler.reconcile(undefined, { tickState: createTickState() });

      expect(compiler.hasFiberTree()).toBe(true);
    });

    it("should throw if no element available", async () => {
      await expect(compiler.reconcile()).rejects.toThrow("No element to reconcile");
    });

    it("should create idle tick state when not provided", async () => {
      let capturedTick: number | undefined;

      const Component = () => {
        const state = useTickState();
        capturedTick = state?.tick;
        return jsx(Section, { id: "test", children: "Hello" });
      };

      // Reconcile without tickState
      await compiler.reconcile(jsx(Component, {}));

      // Should have tick 0 (idle state)
      expect(capturedTick).toBe(0);
    });
  });

  describe("collect()", () => {
    it("should return empty structure before reconcile", () => {
      const structure = compiler.collect();

      expect(structure.sections.size).toBe(0);
      expect(structure.timelineEntries.length).toBe(0);
    });

    it("should collect sections from fiber tree", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });

      await compiler.reconcile(element, { tickState: createTickState() });
      const structure = compiler.collect();

      expect(structure.sections.has("test")).toBe(true);
    });

    it("should be idempotent (multiple calls return same content)", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });

      await compiler.reconcile(element, { tickState: createTickState() });

      const structure1 = compiler.collect();
      const structure2 = compiler.collect();

      // Compare content (not the formatter functions which are different instances)
      const section1 = structure1.sections.get("test");
      const section2 = structure2.sections.get("test");

      expect(section1?.id).toEqual(section2?.id);
      expect(section1?.content).toEqual(section2?.content);
    });

    it("should not run effects", async () => {
      const effectFn = vi.fn();

      const Component = () => {
        useEffect(() => {
          effectFn();
        }, []);
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(Component, {}), { tickState: createTickState() });
      effectFn.mockClear();

      // Collect should not run effects
      compiler.collect();
      compiler.collect();
      compiler.collect();

      expect(effectFn).not.toHaveBeenCalled();
    });
  });

  describe("compile() - convenience method", () => {
    it("should reconcile and collect in one call", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });

      const structure = await compiler.compile(element, createTickState());

      expect(compiler.hasFiberTree()).toBe(true);
      expect(structure.sections.has("test")).toBe(true);
    });

    it("should be equivalent to reconcile + collect", async () => {
      const element = jsx(Section, { id: "test", children: "Hello" });
      const tickState = createTickState();

      // Using compile()
      const structure1 = await compiler.compile(element, tickState);

      // Reset for fresh comparison
      const com2 = new COM();
      const compiler2 = new FiberCompiler(com2);

      // Using reconcile + collect
      await compiler2.reconcile(element, { tickState });
      const structure2 = compiler2.collect();

      // Compare content (not formatter functions)
      const section1 = structure1.sections.get("test");
      const section2 = structure2.sections.get("test");

      expect(section1?.id).toEqual(section2?.id);
      expect(section1?.content).toEqual(section2?.content);
    });
  });

  describe("hasFiberTree()", () => {
    it("should return false before first reconcile", () => {
      expect(compiler.hasFiberTree()).toBe(false);
    });

    it("should return true after reconcile", async () => {
      await compiler.reconcile(jsx(Section, { id: "test" }), { tickState: createTickState() });
      expect(compiler.hasFiberTree()).toBe(true);
    });
  });

  describe("setReconcileCallback", () => {
    it("should call callback when state changes while idle", async () => {
      const callback = vi.fn();
      compiler.setReconcileCallback(callback);

      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      // Create component that exposes its signal for external access
      const Component = () => {
        const count = useSignal(0);
        signalRef = count;
        return jsx(Section, { id: "test", children: String(count()) });
      };

      await compiler.compile(jsx(Component, {}), createTickState());

      // Verify we're idle now
      expect(callback).not.toHaveBeenCalled();

      // Trigger state change while idle
      signalRef!.set(1);

      // Callback should have been called
      expect(callback).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith("fiber state update");
    });
  });
});
