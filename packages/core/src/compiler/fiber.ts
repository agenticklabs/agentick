/**
 * Fiber Node Management
 *
 * Handles fiber creation, cloning, and tree manipulation.
 */

import type { FiberNode, ComponentType, HookState } from "./types";
import { FiberFlags } from "./types";
import type { ContentRenderer } from "../renderers";

// ============================================================================
// Fiber Creation
// ============================================================================

let _fiberIdCounter = 0;

/**
 * Create a new fiber node.
 */
export function createFiber(
  type: ComponentType,
  props: Record<string, unknown>,
  key: string | number | null = null,
): FiberNode {
  const fiber: FiberNode = {
    // Identity
    type,
    key,

    // Props
    props,
    pendingProps: null,

    // State
    stateNode: null,
    memoizedState: null,

    // Tree
    parent: null,
    child: null,
    sibling: null,
    index: 0,

    // Refs
    ref: typeof props.ref === "string" ? props.ref : null,

    // Work tracking
    flags: FiberFlags.NoFlags,
    subtreeFlags: FiberFlags.NoFlags,
    deletions: null,

    // Double buffering
    alternate: null,

    // Rendering
    renderer: null,

    // Debug
    debugName: getDebugName(type),
  };

  return fiber;
}

/**
 * Create a work-in-progress fiber from an existing fiber.
 * This enables double-buffering for safe updates.
 */
export function createWorkInProgress(
  current: FiberNode,
  pendingProps: Record<string, unknown>,
): FiberNode {
  let workInProgress = current.alternate;

  if (workInProgress === null) {
    // First update - create new WIP fiber
    workInProgress = createFiber(current.type, pendingProps, current.key);
    workInProgress.stateNode = current.stateNode;
    workInProgress.alternate = current;
    current.alternate = workInProgress;
  } else {
    // Subsequent update - reuse WIP fiber
    workInProgress.props = pendingProps;
    workInProgress.pendingProps = null;
    workInProgress.type = current.type;

    // Reset flags
    workInProgress.flags = FiberFlags.NoFlags;
    workInProgress.subtreeFlags = FiberFlags.NoFlags;
    workInProgress.deletions = null;
  }

  // Copy memoized state (hooks linked list)
  workInProgress.memoizedState = current.memoizedState;

  // Copy tree pointers (will be updated during reconciliation)
  workInProgress.child = current.child;
  workInProgress.index = current.index;

  // Copy other properties
  workInProgress.ref = current.ref;
  workInProgress.renderer = current.renderer;

  return workInProgress;
}

/**
 * Clone a fiber for use in a different location.
 */
export function cloneFiber(fiber: FiberNode, overrides: Partial<FiberNode> = {}): FiberNode {
  return {
    ...fiber,
    // Reset tree pointers
    parent: null,
    child: null,
    sibling: null,
    // Reset work flags
    flags: FiberFlags.NoFlags,
    subtreeFlags: FiberFlags.NoFlags,
    deletions: null,
    // No alternate for clones
    alternate: null,
    // Apply overrides
    ...overrides,
  };
}

// ============================================================================
// Tree Traversal
// ============================================================================

/**
 * Get all child fibers as an array.
 */
export function getChildFibers(fiber: FiberNode | null): FiberNode[] {
  const children: FiberNode[] = [];
  let child = fiber?.child ?? null;

  while (child !== null) {
    children.push(child);
    child = child.sibling;
  }

  return children;
}

/**
 * Find a fiber by key among siblings.
 */
export function findFiberByKey(
  firstChild: FiberNode | null,
  key: string | number | null,
): FiberNode | null {
  let fiber = firstChild;

  while (fiber !== null) {
    if (fiber.key === key) {
      return fiber;
    }
    fiber = fiber.sibling;
  }

  return null;
}

/**
 * Traverse fiber tree depth-first, calling callback on each fiber.
 */
export async function traverseFiber(
  fiber: FiberNode | null,
  callback: (fiber: FiberNode) => void | Promise<void>,
): Promise<void> {
  if (fiber === null) return;

  await callback(fiber);

  let child = fiber.child;
  while (child !== null) {
    await traverseFiber(child, callback);
    child = child.sibling;
  }
}

/**
 * Traverse fiber tree bottom-up (children first, then parent).
 */
export async function traverseFiberBottomUp(
  fiber: FiberNode | null,
  callback: (fiber: FiberNode) => void | Promise<void>,
): Promise<void> {
  if (fiber === null) return;

  // Process children first
  let child = fiber.child;
  while (child !== null) {
    await traverseFiberBottomUp(child, callback);
    child = child.sibling;
  }

  // Then this fiber
  await callback(fiber);
}

// ============================================================================
// Hook State Helpers
// ============================================================================

/**
 * Get the number of hooks on a fiber.
 */
export function getHookCount(fiber: FiberNode): number {
  let count = 0;
  let hook = fiber.memoizedState;

  while (hook !== null) {
    count++;
    hook = hook.next;
  }

  return count;
}

/**
 * Get hook at a specific index.
 */
export function getHookAtIndex(fiber: FiberNode, index: number): HookState | null {
  let hook = fiber.memoizedState;
  let i = 0;

  while (hook !== null && i < index) {
    hook = hook.next;
    i++;
  }

  return hook;
}

// ============================================================================
// Debugging
// ============================================================================

/**
 * Get a debug name for a component type.
 */
function getDebugName(type: ComponentType): string {
  if (typeof type === "function") {
    return type.name || "Anonymous";
  }
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "symbol") {
    return type.description || "Symbol";
  }
  return "Unknown";
}

/**
 * Create a debug string representation of a fiber.
 */
export function fiberToDebugString(fiber: FiberNode): string {
  const key = fiber.key !== null ? ` key="${fiber.key}"` : "";
  const flags = fiber.flags !== 0 ? ` flags=${fiber.flags}` : "";
  return `<${fiber.debugName}${key}${flags}>`;
}

/**
 * Create a debug tree representation.
 */
export function fiberTreeToDebugString(fiber: FiberNode | null, indent = 0): string {
  if (fiber === null) return "";

  const prefix = "  ".repeat(indent);
  let result = prefix + fiberToDebugString(fiber) + "\n";

  let child = fiber.child;
  while (child !== null) {
    result += fiberTreeToDebugString(child, indent + 1);
    child = child.sibling;
  }

  return result;
}

// ============================================================================
// Renderer Context
// ============================================================================

/**
 * Find the nearest renderer in the fiber tree.
 */
export function findNearestRenderer(fiber: FiberNode): ContentRenderer | null {
  let current: FiberNode | null = fiber;

  while (current !== null) {
    if (current.renderer !== null) {
      return current.renderer;
    }
    current = current.parent;
  }

  return null;
}

/**
 * Set renderer on fiber and mark for propagation.
 */
export function setFiberRenderer(fiber: FiberNode, renderer: ContentRenderer): void {
  fiber.renderer = renderer;
}
