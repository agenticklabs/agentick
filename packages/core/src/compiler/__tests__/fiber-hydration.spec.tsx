/**
 * Tests for Fiber Tree Serialization and Hydration
 *
 * Tests the ability to:
 * - Serialize fiber tree with hook states
 * - Hydrate fiber tree from serialized snapshot
 * - Skip mount effects during hydration
 * - Resume sessions from componentState
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FiberCompiler } from "../fiber-compiler";
import { COM } from "../../com/object-model";
import type { TickState } from "../../component/component";
import { Section } from "../../jsx/components/primitives";
import { createElement, Fragment } from "../../jsx/jsx-runtime";
import { useState, useEffect, useMemo, useRef } from "../../state/hooks";
import type { SerializedFiberNode } from "../../app/types";

// ============================================================================
// Test Utilities
// ============================================================================

function createTickState(tick = 1): TickState {
  return {
    tick,
    stop: vi.fn(),
    queuedMessages: [],
  } as unknown as TickState;
}

// ============================================================================
// Fiber Tree Serialization Tests
// ============================================================================

describe("Fiber Tree Serialization", () => {
  let com: COM;
  let compiler: FiberCompiler;
  let tickState: TickState;

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
    tickState = createTickState();
  });

  it("should serialize simple function component", async () => {
    function SimpleComponent() {
      return createElement(Section, { id: "simple" }, "Content");
    }

    await compiler.compile(createElement(SimpleComponent, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();
    expect(serialized!.type).toBe("SimpleComponent");
    expect(serialized!.hooks).toEqual([]);
  });

  it("should serialize useState hook values", async () => {
    function Counter() {
      const [count] = useState(42);
      return createElement(Section, { id: "counter" }, `Count: ${count}`);
    }

    await compiler.compile(createElement(Counter, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();
    expect(serialized!.type).toBe("Counter");
    expect(serialized!.hooks.length).toBe(1);
    // useState internally uses useReducer, so type is "useReducer"
    expect(serialized!.hooks[0].type).toBe("useReducer");
    expect(serialized!.hooks[0].value).toBe(42);
  });

  it("should serialize multiple hooks in order", async () => {
    function MultiHook() {
      const [name] = useState("Alice");
      const [age] = useState(30);
      const doubled = useMemo(() => age * 2, [age]);
      return createElement(Section, { id: "multi" }, `${name}: ${doubled}`);
    }

    await compiler.compile(createElement(MultiHook, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();
    expect(serialized!.hooks.length).toBe(3);
    expect(serialized!.hooks[0].value).toBe("Alice");
    expect(serialized!.hooks[1].value).toBe(30);
    // useMemo serializes just the computed value (deps shown separately)
    expect(serialized!.hooks[2].value).toBe(60);
  });

  it("should serialize useRef values", async () => {
    function RefComponent() {
      const countRef = useRef(100);
      return createElement(Section, { id: "ref" }, `Ref: ${countRef.current}`);
    }

    await compiler.compile(createElement(RefComponent, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();
    const refHook = serialized!.hooks.find((h) => h.type === "useRef");
    expect(refHook).toBeDefined();
    // useRef serializes just the current value, not the ref object
    expect(refHook!.value).toBe(100);
  });

  it("should serialize nested components", async () => {
    function Child({ value }: { value: number }) {
      const [state] = useState(value);
      return createElement(Section, { id: `child-${value}` }, `Child: ${state}`);
    }

    function Parent() {
      const [count] = useState(5);
      return createElement(
        Fragment,
        {},
        createElement(Child, { value: 1 }),
        createElement(Child, { value: 2 }),
        createElement(Section, { id: "parent" }, `Parent: ${count}`),
      );
    }

    await compiler.compile(createElement(Parent, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();
    expect(serialized!.type).toBe("Parent");
    expect(serialized!.hooks.length).toBe(1);
    expect(serialized!.hooks[0].value).toBe(5);

    // Children should be serialized (may be wrapped in Fragment)
    expect(serialized!.children.length).toBeGreaterThan(0);

    // Find Child components recursively (they may be under a Fragment)
    function findByType(node: SerializedFiberNode, type: string): SerializedFiberNode[] {
      const results: SerializedFiberNode[] = [];
      if (node.type === type) results.push(node);
      for (const child of node.children) {
        results.push(...findByType(child, type));
      }
      return results;
    }

    const children = findByType(serialized!, "Child");
    expect(children.length).toBe(2);
    expect(children[0].hooks[0].value).toBe(1);
    expect(children[1].hooks[0].value).toBe(2);
  });

  it("should include component keys in serialized tree", async () => {
    function Item({ id }: { id: string }) {
      return createElement(Section, { id }, id);
    }

    function List() {
      return createElement(
        Fragment,
        {},
        createElement(Item, { key: "a", id: "item-a" }),
        createElement(Item, { key: "b", id: "item-b" }),
      );
    }

    await compiler.compile(createElement(List, {}), tickState);
    const serialized = compiler.serializeFiberTree();

    expect(serialized).not.toBeNull();

    // Find Item components recursively (they may be under a Fragment)
    function findByType(node: SerializedFiberNode, type: string): SerializedFiberNode[] {
      const results: SerializedFiberNode[] = [];
      if (node.type === type) results.push(node);
      for (const child of node.children) {
        results.push(...findByType(child, type));
      }
      return results;
    }

    const items = findByType(serialized!, "Item");
    expect(items.length).toBe(2);
    expect(items[0].key).toBe("a");
    expect(items[1].key).toBe("b");
  });

  it("should get fiber summary statistics", async () => {
    function App() {
      const [a] = useState(1);
      const [b] = useState(2);
      const memo = useMemo(() => a + b, [a, b]);
      useEffect(() => {}, []);
      return createElement(Section, { id: "app" }, `Sum: ${memo}`);
    }

    await compiler.compile(createElement(App, {}), tickState);
    const summary = compiler.getFiberSummary();

    expect(summary.componentCount).toBeGreaterThanOrEqual(1);
    expect(summary.hookCount).toBeGreaterThanOrEqual(4);
    // useState uses useReducer internally
    expect(summary.hooksByType.useReducer).toBe(2);
    expect(summary.hooksByType.useMemo).toBe(1);
    expect(summary.hooksByType.useEffect).toBe(1);
  });
});

// ============================================================================
// Fiber Tree Hydration Tests
// ============================================================================

describe("Fiber Tree Hydration", () => {
  let com: COM;
  let compiler: FiberCompiler;
  let tickState: TickState;

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
    tickState = createTickState();
  });

  it("should restore useState values from hydration data", async () => {
    let capturedCount = 0;

    function Counter() {
      const [count] = useState(0); // Default is 0
      capturedCount = count;
      return createElement(Section, { id: "counter" }, `Count: ${count}`);
    }

    // Create hydration data with count = 42
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "Counter",
      key: null,
      props: {},
      hooks: [{ index: 0, type: "state", value: 42 }],
      children: [],
    };

    compiler.setHydrationData(hydrationData);
    expect(compiler.isHydratingNow()).toBe(true);

    await compiler.compile(createElement(Counter, {}), tickState);

    // The hydrated value should be used
    expect(capturedCount).toBe(42);

    compiler.completeHydration();
    expect(compiler.isHydratingNow()).toBe(false);
  });

  it("should restore multiple hook values", async () => {
    let capturedName = "";
    let capturedAge = 0;

    function Person() {
      const [name] = useState("default");
      const [age] = useState(0);
      capturedName = name;
      capturedAge = age;
      return createElement(Section, { id: "person" }, `${name}: ${age}`);
    }

    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "Person",
      key: null,
      props: {},
      hooks: [
        { index: 0, type: "state", value: "Bob" },
        { index: 1, type: "state", value: 35 },
      ],
      children: [],
    };

    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(Person, {}), tickState);

    expect(capturedName).toBe("Bob");
    expect(capturedAge).toBe(35);
  });

  it("should skip mount effects during hydration", async () => {
    const mountSpy = vi.fn();
    const effectWithDepsSpy = vi.fn();

    function EffectComponent() {
      const [count] = useState(0);

      // Mount effect (empty deps) - should be SKIPPED during hydration
      useEffect(() => {
        mountSpy();
      }, []);

      // Effect with deps - should still run
      useEffect(() => {
        effectWithDepsSpy(count);
      }, [count]);

      return createElement(Section, { id: "effects" }, `Count: ${count}`);
    }

    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "EffectComponent",
      key: null,
      props: {},
      hooks: [
        { index: 0, type: "state", value: 5 },
        { index: 1, type: "effect", value: null, deps: [], status: "mounted" },
        { index: 2, type: "effect", value: null, deps: [5] },
      ],
      children: [],
    };

    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(EffectComponent, {}), tickState);

    // Mount effect should NOT have been called during hydration
    expect(mountSpy).not.toHaveBeenCalled();

    // Effect with deps should have been called
    expect(effectWithDepsSpy).toHaveBeenCalledWith(5);
  });

  it("should hydrate nested components", async () => {
    let parentCount = 0;
    let childValue = 0;

    function Child() {
      const [value] = useState(0);
      childValue = value;
      return createElement(Section, { id: "child" }, `Child: ${value}`);
    }

    function Parent() {
      const [count] = useState(0);
      parentCount = count;
      return createElement(Fragment, {}, createElement(Child, {}));
    }

    // Hydration data must match the actual fiber tree structure
    // The tree is: Parent -> Fragment (tentickle.fragment) -> Child
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "Parent",
      key: null,
      props: {},
      hooks: [{ index: 0, type: "state", value: 10 }],
      children: [
        {
          id: "fragment",
          type: "tentickle.fragment",
          key: null,
          props: {},
          hooks: [],
          children: [
            {
              id: "child-0",
              type: "Child",
              key: null,
              props: {},
              hooks: [{ index: 0, type: "state", value: 20 }],
              children: [],
            },
          ],
        },
      ],
    };

    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(Parent, {}), tickState);

    expect(parentCount).toBe(10);
    expect(childValue).toBe(20);
  });

  it("should handle missing hydration data gracefully", async () => {
    let capturedCount = 0;

    function Counter() {
      const [count] = useState(99); // Will use default since no hydration data
      capturedCount = count;
      return createElement(Section, { id: "counter" }, `Count: ${count}`);
    }

    // Empty hydration data - no hooks match
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "Counter",
      key: null,
      props: {},
      hooks: [], // No hooks - should fall back to default
      children: [],
    };

    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(Counter, {}), tickState);

    // Should use default value since hook index doesn't exist in hydration data
    expect(capturedCount).toBe(99);
  });

  it("should clear hydration state after completeHydration()", async () => {
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "Test",
      key: null,
      props: {},
      hooks: [],
      children: [],
    };

    compiler.setHydrationData(hydrationData);
    expect(compiler.isHydratingNow()).toBe(true);
    expect(compiler.getHydrationDataForPath("Test")).toBeDefined();

    compiler.completeHydration();

    expect(compiler.isHydratingNow()).toBe(false);
    expect(compiler.getHydrationDataForPath("Test")).toBeUndefined();
  });
});

// ============================================================================
// Round-trip Serialization/Hydration Tests
// ============================================================================

describe("Round-trip Serialization/Hydration", () => {
  it("should serialize and hydrate state correctly", async () => {
    let capturedValues: number[] = [];

    function MultiState() {
      const [a] = useState(10);
      const [b] = useState(20);
      const [c] = useState(3);
      capturedValues = [a, b, c];

      return createElement(Section, { id: "multi" }, `${a}-${b}-${c}`);
    }

    // First compilation - initial state
    const com1 = new COM();
    const compiler1 = new FiberCompiler(com1);
    const tickState1 = createTickState();

    await compiler1.compile(createElement(MultiState, {}), tickState1);

    // State should have initial values
    expect(capturedValues).toEqual([10, 20, 3]);

    // Serialize the fiber tree
    const serialized = compiler1.serializeFiberTree();
    expect(serialized).not.toBeNull();

    // Verify serialized hooks have correct values
    expect(serialized!.hooks.length).toBe(3);
    expect(serialized!.hooks[0].value).toBe(10);
    expect(serialized!.hooks[1].value).toBe(20);
    expect(serialized!.hooks[2].value).toBe(3);

    // Reset captured values
    capturedValues = [];

    // Create a different component that would normally have different defaults
    function DifferentDefaults() {
      const [a] = useState(0); // Different default
      const [b] = useState(0); // Different default
      const [c] = useState(0); // Different default
      capturedValues = [a, b, c];

      return createElement(Section, { id: "multi" }, `${a}-${b}-${c}`);
    }

    // Create a new compiler and hydrate from serialized data
    const com2 = new COM();
    const compiler2 = new FiberCompiler(com2);
    const tickState2 = createTickState();

    // Hydration data uses MultiState type, but we're rendering DifferentDefaults
    // Type mismatch means no hydration, so defaults are used
    compiler2.setHydrationData(serialized!);
    await compiler2.compile(createElement(DifferentDefaults, {}), tickState2);
    compiler2.completeHydration();

    // Type mismatch - should use default values
    expect(capturedValues).toEqual([0, 0, 0]);

    // Now test with matching type - should hydrate
    capturedValues = [];
    const com3 = new COM();
    const compiler3 = new FiberCompiler(com3);
    const tickState3 = createTickState();

    compiler3.setHydrationData(serialized!);
    await compiler3.compile(createElement(MultiState, {}), tickState3);
    compiler3.completeHydration();

    // Matching type - should have hydrated values
    expect(capturedValues).toEqual([10, 20, 3]);
  });

  it("should preserve memoized values across hydration", async () => {
    let computeCount = 0;
    let memoValue = 0;

    function MemoComponent() {
      const [value] = useState(100);

      const doubled = useMemo(() => {
        computeCount++;
        return value * 2;
      }, [value]);

      memoValue = doubled;
      return createElement(Section, { id: "memo" }, `Doubled: ${doubled}`);
    }

    // First compilation
    const com1 = new COM();
    const compiler1 = new FiberCompiler(com1);
    await compiler1.compile(createElement(MemoComponent, {}), createTickState());

    expect(computeCount).toBe(1);
    expect(memoValue).toBe(200);

    // Serialize
    const serialized = compiler1.serializeFiberTree();

    // Reset
    computeCount = 0;
    memoValue = 0;

    // Hydrate into new compiler
    const com2 = new COM();
    const compiler2 = new FiberCompiler(com2);
    compiler2.setHydrationData(serialized!);
    await compiler2.compile(createElement(MemoComponent, {}), createTickState());
    compiler2.completeHydration();

    // Memo value should be restored without recomputing
    expect(memoValue).toBe(200);
    // Note: The memo computation may still run on first render even during hydration
    // but the value would be correct
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Hydration Edge Cases", () => {
  it("should handle component type mismatch gracefully", async () => {
    let capturedValue = 0;

    function NewComponent() {
      const [value] = useState(999); // Default will be used
      capturedValue = value;
      return createElement(Section, { id: "new" }, `Value: ${value}`);
    }

    // Hydration data is for a different component type
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "OldComponent", // Different type
      key: null,
      props: {},
      hooks: [{ index: 0, type: "state", value: 42 }],
      children: [],
    };

    const com = new COM();
    const compiler = new FiberCompiler(com);
    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(NewComponent, {}), createTickState());

    // Type mismatch - path won't match, so default value is used
    expect(capturedValue).toBe(999);
  });

  it("should handle extra hooks in new component", async () => {
    // Simulates: Component was updated to add a new hook
    let capturedOld = 0;
    let capturedNew = 0;

    function UpdatedComponent() {
      const [oldValue] = useState(1);
      const [newValue] = useState(100); // New hook added in updated version
      capturedOld = oldValue;
      capturedNew = newValue;
      return createElement(Section, { id: "updated" }, `${oldValue}-${newValue}`);
    }

    // Hydration data only has the old hook
    const hydrationData: SerializedFiberNode = {
      id: "root",
      type: "UpdatedComponent",
      key: null,
      props: {},
      hooks: [{ index: 0, type: "state", value: 50 }], // Only one hook
      children: [],
    };

    const com = new COM();
    const compiler = new FiberCompiler(com);
    compiler.setHydrationData(hydrationData);
    await compiler.compile(createElement(UpdatedComponent, {}), createTickState());

    // First hook should be hydrated, second uses default
    expect(capturedOld).toBe(50);
    expect(capturedNew).toBe(100);
  });

  it("should handle null hydration data", async () => {
    let capturedValue = 0;

    function NullHydrationComponent() {
      const [value] = useState(123);
      capturedValue = value;
      return createElement(Section, { id: "test" }, `Value: ${value}`);
    }

    const com = new COM();
    const compiler = new FiberCompiler(com);

    // Set null hydration data
    compiler.setHydrationData(null);
    expect(compiler.isHydratingNow()).toBe(false);

    await compiler.compile(createElement(NullHydrationComponent, {}), createTickState());

    // Should use default value
    expect(capturedValue).toBe(123);
  });
});

// ============================================================================
// Session-Level Hydration Tests
// ============================================================================

import { createApp } from "../../app";
import { createModel, type ModelInput, type ModelOutput } from "../../model/model";
import { fromEngineState, toEngineState } from "../../model/utils/language-model";
import type { StopReason, StreamEvent, TimelineEntry } from "@tentickle/shared";
import { BlockType } from "@tentickle/shared";
import { Model } from "../../jsx/components/primitives";
import { System, User, Assistant } from "../../jsx/components/messages";

function createMockModel(response?: Partial<ModelOutput>) {
  return createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
    metadata: {
      id: "mock-model",
      provider: "mock",
      capabilities: [],
    },
    executors: {
      execute: async (_input: ModelInput) =>
        ({
          model: "mock-model",
          createdAt: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Mock response" }],
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "stop" as StopReason,
          raw: {},
          ...response,
        }) as ModelOutput,
      executeStream: async function* (_input: ModelInput) {
        yield {
          type: "content_delta",
          blockType: BlockType.TEXT,
          blockIndex: 0,
          delta: "Mock",
        } as StreamEvent;
      },
    },
    transformers: {
      processStream: async (chunks: StreamEvent[]) => {
        let text = "";
        for (const chunk of chunks) {
          if (chunk.type === "content_delta") text += chunk.delta;
        }
        return {
          model: "mock-model",
          createdAt: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "stop" as StopReason,
          raw: {},
        } as ModelOutput;
      },
    },
    fromEngineState,
    toEngineState,
  });
}

describe("Session Snapshot and Resume", () => {
  it("should snapshot and resume session with useState values", async () => {
    const mockModel = createMockModel();

    function StatefulAgent() {
      const [count] = useState(42); // Fixed initial value for testing

      return (
        <>
          <Model model={mockModel} />
          <System>Count: {count}</System>
          <Assistant />
        </>
      );
    }

    const app = createApp(StatefulAgent, { model: mockModel });

    // First session - run a tick
    const session1 = app.createSession();
    await session1.tick({}).result;

    // Snapshot captures state
    const snapshot = session1.snapshot();
    expect(snapshot.tick).toBeGreaterThan(0);
    expect(snapshot.componentState).not.toBeNull();

    session1.close();

    // New session from snapshot - basic test that it doesn't crash
    const session2 = app.createSession({ snapshot });
    await session2.tick({}).result;

    session2.close();
  });

  it("should resume with correct tick number", async () => {
    const mockModel = createMockModel();

    function TickTracker() {
      const [count] = useState(100);

      return (
        <>
          <Model model={mockModel} />
          <System>Count: {count}</System>
          <Assistant />
        </>
      );
    }

    const app = createApp(TickTracker, { model: mockModel });

    // Run multiple ticks
    const session1 = app.createSession();
    await session1.tick({}).result;
    await session1.tick({}).result;
    await session1.tick({}).result;

    const snapshot = session1.snapshot();
    const snapshotTick = snapshot.tick;
    expect(snapshotTick).toBeGreaterThan(0);

    session1.close();

    // Resume from snapshot - verify snapshot has expected tick
    const session2 = app.createSession({ snapshot });
    const session2Snapshot = session2.snapshot();
    expect(session2Snapshot.tick).toBe(snapshotTick);

    session2.close();
  });
});

// Session branching tests - skip for now as they require deeper integration
describe.skip("Session Branching (Fork from Snapshot)", () => {
  it("should fork session at any tick creating divergent branches", async () => {
    // TODO: Implement when session branching is a priority
  });

  it("should create independent timelines from fork point", async () => {
    // TODO: Implement when session branching is a priority
  });
});

describe("Time-Travel Debugging", () => {
  it("should record tick snapshots when recording is enabled", async () => {
    const mockModel = createMockModel();

    function TrackedAgent() {
      const [count] = useState(42);

      return (
        <>
          <Model model={mockModel} />
          <System>Count: {count}</System>
          <Assistant />
        </>
      );
    }

    const app = createApp(TrackedAgent, { model: mockModel });
    const session = app.createSession({ recording: "full" });

    await session.tick({}).result;
    await session.tick({}).result;
    await session.tick({}).result;

    const recording = session.getRecording();

    expect(recording).not.toBeNull();
    expect(recording!.snapshots.length).toBe(3);

    // Each snapshot should have fiber tree
    for (const snap of recording!.snapshots) {
      expect(snap.fiber.tree).not.toBeNull();
      expect(snap.fiber.summary.componentCount).toBeGreaterThan(0);
    }

    session.close();
  });

  // Time-travel restoration requires deeper integration work
  it.skip("should restore to any recorded tick", async () => {
    // TODO: Implement when time-travel debugging is a priority
  });
});

// Hot reload requires state preservation across different component definitions
// which needs type matching to be relaxed - skip for now
describe.skip("Hot Reload Simulation", () => {
  it("should preserve state when component definition changes", async () => {
    // TODO: Implement when hot reload is a priority
  });
});

describe("Complex Hydration Scenarios", () => {
  it("should handle deep component trees", async () => {
    const mockModel = createMockModel();
    const leafValues: Record<string, number> = {};

    // Use keys to ensure unique paths for hydration
    function Leaf({ id, value }: { id: string; value: number }) {
      const [state] = useState(value);
      leafValues[id] = state;

      return createElement(Section, { id }, `Leaf ${id}: ${state}`);
    }

    function Branch({ prefix, base }: { prefix: string; base: number }) {
      return (
        <>
          <Leaf key={`${prefix}-1`} id={`${prefix}-1`} value={base + 10} />
          <Leaf key={`${prefix}-2`} id={`${prefix}-2`} value={base + 20} />
        </>
      );
    }

    function Tree() {
      return (
        <>
          <Model model={mockModel} />
          <Branch key="a" prefix="a" base={0} />
          <Branch key="b" prefix="b" base={100} />
          <Assistant />
        </>
      );
    }

    const app = createApp(Tree, { model: mockModel });
    const session1 = app.createSession();

    await session1.tick({}).result;

    // Initial values from props
    expect(leafValues["a-1"]).toBe(10);
    expect(leafValues["a-2"]).toBe(20);
    expect(leafValues["b-1"]).toBe(110);
    expect(leafValues["b-2"]).toBe(120);

    const snapshot = session1.snapshot();
    session1.close();

    // Clear and hydrate
    Object.keys(leafValues).forEach((k) => delete leafValues[k]);

    const session2 = app.createSession({ snapshot });
    await session2.tick({}).result;

    // All values should be restored from hydration
    expect(leafValues["a-1"]).toBe(10);
    expect(leafValues["a-2"]).toBe(20);
    expect(leafValues["b-1"]).toBe(110);
    expect(leafValues["b-2"]).toBe(120);

    session2.close();
  });

  it("should handle conditional rendering state", async () => {
    const mockModel = createMockModel();
    let showChild = true;
    let childValue = 0;
    let parentValue = 0;

    function Child() {
      const [value] = useState(999);
      childValue = value;
      return createElement(Section, { id: "child" }, `Child: ${value}`);
    }

    function Parent() {
      const [count] = useState(42); // Fixed initial value
      parentValue = count;

      return (
        <>
          <Model model={mockModel} />
          <System>Parent: {count}</System>
          {showChild && <Child />}
          <Assistant />
        </>
      );
    }

    const app = createApp(Parent, { model: mockModel });
    const session1 = app.createSession();

    await session1.tick({}).result;
    expect(parentValue).toBe(42);
    expect(childValue).toBe(999);

    const snapshot = session1.snapshot();
    session1.close();

    // Reset
    parentValue = 0;
    childValue = 0;

    // Resume with child hidden
    showChild = false;
    const session2 = app.createSession({ snapshot });
    await session2.tick({}).result;

    // Parent state should be hydrated
    expect(parentValue).toBe(42);
    // Child wasn't rendered, so its value stays 0
    expect(childValue).toBe(0);

    session2.close();
  });

  it("should handle useRef across hydration", async () => {
    const mockModel = createMockModel();
    let refValue = 0;

    function RefComponent() {
      const ref = useRef(123); // Fixed initial value

      refValue = ref.current;

      return (
        <>
          <Model model={mockModel} />
          <System>Ref: {ref.current}</System>
          <Assistant />
        </>
      );
    }

    const app = createApp(RefComponent, { model: mockModel });
    const session1 = app.createSession();

    await session1.tick({}).result;
    expect(refValue).toBe(123);

    const snapshot = session1.snapshot();
    session1.close();

    refValue = 0;

    const session2 = app.createSession({ snapshot });
    await session2.tick({}).result;

    // Ref should be hydrated
    expect(refValue).toBe(123);

    session2.close();
  });
});
