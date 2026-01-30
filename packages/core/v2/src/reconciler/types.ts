/**
 * V2 Reconciler Types
 *
 * Core types for the react-reconciler based implementation.
 */

import type { Renderer } from "../renderers/types";

/**
 * A node in the Tentickle tree built by react-reconciler.
 * This is the "host instance" in React terminology.
 */
export interface TentickleNode {
  /** Component type (function, class, string for intrinsics, symbol for Fragment) */
  type: TentickleNodeType;

  /** Props passed to the component */
  props: Record<string, unknown>;

  /** Child nodes */
  children: TentickleNode[];

  /** Parent node (for traversal) */
  parent: TentickleNode | null;

  /** Renderer context inherited from ancestors */
  renderer: Renderer | null;

  /** Unique key for reconciliation */
  key: string | number | null;

  /** Index among siblings */
  index: number;
}

/**
 * Valid node types in the tree.
 */
export type TentickleNodeType =
  | string // Intrinsic elements
  | ((...args: unknown[]) => unknown) // Function components
  | { new (...args: unknown[]): unknown } // Class components
  | symbol; // Fragment

/**
 * The container (root) of the Tentickle tree.
 */
export interface TentickleContainer {
  /** Root children */
  children: TentickleNode[];

  /** Default renderer for the tree */
  renderer: Renderer;
}

/**
 * Host context passed through the tree.
 * Used for nested renderer inheritance.
 */
export interface HostContext {
  /** Current renderer in scope */
  renderer: Renderer;
}

/**
 * Props type (generic record).
 */
export type Props = Record<string, unknown>;

/**
 * Update payload for commitUpdate.
 */
export interface UpdatePayload {
  props: Props;
}

/**
 * Create a new TentickleNode.
 */
export function createNode(
  type: TentickleNodeType,
  props: Props,
  renderer: Renderer | null,
  key: string | number | null = null,
): TentickleNode {
  return {
    type,
    props,
    children: [],
    parent: null,
    renderer,
    key,
    index: 0,
  };
}
