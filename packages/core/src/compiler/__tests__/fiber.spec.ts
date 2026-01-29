/**
 * Tests for Fiber Utilities
 */

import {
  createFiber,
  createWorkInProgress,
  cloneFiber,
  getChildFibers,
  findFiberByKey,
  traverseFiber,
  traverseFiberBottomUp,
  getHookCount,
  getHookAtIndex,
  fiberToDebugString,
  fiberTreeToDebugString,
} from "../fiber";

describe("Fiber Utilities", () => {
  describe("createFiber", () => {
    it("should create fiber with type and props", () => {
      const fiber = createFiber("div", { id: "test" }, "key1");

      expect(fiber.type).toBe("div");
      expect(fiber.props.id).toBe("test");
      expect(fiber.key).toBe("key1");
    });

    it("should create fiber with null key", () => {
      const fiber = createFiber("div", {}, null);

      expect(fiber.key).toBeNull();
    });

    it("should extract ref from props", () => {
      const fiber = createFiber("div", { ref: "myRef" }, null);

      expect(fiber.ref).toBe("myRef");
    });

    it("should initialize with default values", () => {
      const fiber = createFiber("div", {}, null);

      expect(fiber.stateNode).toBeNull();
      expect(fiber.memoizedState).toBeNull();
      expect(fiber.parent).toBeNull();
      expect(fiber.child).toBeNull();
      expect(fiber.sibling).toBeNull();
      expect(fiber.flags).toBe(0);
    });
  });

  describe("createWorkInProgress", () => {
    it("should create work-in-progress fiber", () => {
      const current = createFiber("div", { id: "old" }, null);
      current.stateNode = { props: {} } as any;
      current.memoizedState = {} as any;

      const wip = createWorkInProgress(current, { id: "new" });

      expect(wip.type).toBe("div");
      expect(wip.props.id).toBe("new");
      expect(wip.alternate).toBe(current);
      expect(current.alternate).toBe(wip);
    });

    it("should reuse existing work-in-progress", () => {
      const current = createFiber("div", {}, null);
      const wip1 = createWorkInProgress(current, { id: "first" });
      const wip2 = createWorkInProgress(current, { id: "second" });

      expect(wip1).toBe(wip2);
      expect(wip2.props.id).toBe("second");
    });

    it("should copy memoized state", () => {
      const current = createFiber("div", {}, null);
      const hookState = { tag: 0, memoizedState: "test" } as any;
      current.memoizedState = hookState;

      const wip = createWorkInProgress(current, {});

      expect(wip.memoizedState).toBe(hookState);
    });
  });

  describe("cloneFiber", () => {
    it("should clone fiber with overrides", () => {
      const original = createFiber("div", { id: "original" }, "key1");
      original.child = createFiber("span", {}, null);

      const clone = cloneFiber(original, { props: { id: "cloned" } });

      expect(clone.type).toBe("div");
      expect(clone.props.id).toBe("cloned");
      expect(clone.key).toBe("key1");
      expect(clone.parent).toBeNull();
      expect(clone.alternate).toBeNull();
    });
  });

  describe("getChildFibers", () => {
    it("should return empty array for null fiber", () => {
      expect(getChildFibers(null)).toEqual([]);
    });

    it("should return all child fibers", () => {
      const parent = createFiber("div", {}, null);
      const child1 = createFiber("span", {}, null);
      const child2 = createFiber("span", {}, null);

      parent.child = child1;
      child1.sibling = child2;

      const children = getChildFibers(parent);

      expect(children).toHaveLength(2);
      expect(children[0]).toBe(child1);
      expect(children[1]).toBe(child2);
    });
  });

  describe("findFiberByKey", () => {
    it("should find fiber by key", () => {
      const parent = createFiber("div", {}, null);
      const child1 = createFiber("span", {}, "key1");
      const child2 = createFiber("span", {}, "key2");

      parent.child = child1;
      child1.sibling = child2;

      const found = findFiberByKey(parent.child, "key2");

      expect(found).toBe(child2);
    });

    it("should return null if key not found", () => {
      const parent = createFiber("div", {}, null);
      const child = createFiber("span", {}, "key1");

      parent.child = child;

      const found = findFiberByKey(parent.child, "not-found");

      expect(found).toBeNull();
    });
  });

  describe("traverseFiber", () => {
    it("should traverse tree depth-first", async () => {
      const root = createFiber("div", {}, null);
      const child1 = createFiber("span", {}, null);
      const child2 = createFiber("span", {}, null);
      const grandchild = createFiber("p", {}, null);

      root.child = child1;
      child1.sibling = child2;
      child1.child = grandchild;

      const visited: string[] = [];
      await traverseFiber(root, (fiber) => {
        visited.push(fiber.debugName || "unknown");
      });

      expect(visited).toEqual(["div", "span", "p", "span"]);
    });

    it("should handle null fiber", async () => {
      const visited: string[] = [];
      await traverseFiber(null, (fiber) => {
        visited.push(fiber.debugName || "unknown");
      });

      expect(visited).toEqual([]);
    });
  });

  describe("traverseFiberBottomUp", () => {
    it("should traverse tree bottom-up", async () => {
      const root = createFiber("div", {}, null);
      const child1 = createFiber("span", {}, null);
      const child2 = createFiber("span", {}, null);
      const grandchild = createFiber("p", {}, null);

      root.child = child1;
      child1.sibling = child2;
      child1.child = grandchild;

      const visited: string[] = [];
      await traverseFiberBottomUp(root, (fiber) => {
        visited.push(fiber.debugName || "unknown");
      });

      // Should visit children before parent
      expect(visited[0]).toBe("p");
      expect(visited[visited.length - 1]).toBe("div");
    });
  });

  describe("getHookCount", () => {
    it("should return 0 for no hooks", () => {
      const fiber = createFiber("div", {}, null);

      expect(getHookCount(fiber)).toBe(0);
    });

    it("should count hooks in linked list", () => {
      const fiber = createFiber("div", {}, null);
      const hook1 = { next: null } as any;
      const hook2 = { next: null } as any;
      const hook3 = { next: null } as any;

      hook1.next = hook2;
      hook2.next = hook3;
      fiber.memoizedState = hook1;

      expect(getHookCount(fiber)).toBe(3);
    });
  });

  describe("getHookAtIndex", () => {
    it("should return hook at index", () => {
      const fiber = createFiber("div", {}, null);
      const hook1 = { next: null, tag: 0 } as any;
      const hook2 = { next: null, tag: 1 } as any;

      hook1.next = hook2;
      fiber.memoizedState = hook1;

      expect(getHookAtIndex(fiber, 0)).toBe(hook1);
      expect(getHookAtIndex(fiber, 1)).toBe(hook2);
    });

    it("should return null for out of bounds", () => {
      const fiber = createFiber("div", {}, null);
      const hook = { next: null } as any;
      fiber.memoizedState = hook;

      expect(getHookAtIndex(fiber, 0)).toBe(hook);
      expect(getHookAtIndex(fiber, 1)).toBeNull();
    });
  });

  describe("fiberToDebugString", () => {
    it("should create debug string", () => {
      const fiber = createFiber("MyComponent", { id: "test" }, "key1");
      fiber.flags = 1; // Placement flag

      const str = fiberToDebugString(fiber);

      expect(str).toContain("MyComponent");
      expect(str).toContain('key="key1"');
      expect(str).toContain("flags=1");
    });
  });

  describe("fiberTreeToDebugString", () => {
    it("should create tree debug string", () => {
      const root = createFiber("Root", {}, null);
      const child = createFiber("Child", {}, null);

      root.child = child;

      const str = fiberTreeToDebugString(root);

      expect(str).toContain("Root");
      expect(str).toContain("Child");
    });
  });
});
