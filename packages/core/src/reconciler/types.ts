/**
 * V2 Reconciler Types
 *
 * Core types for the react-reconciler based implementation.
 */

import type { Renderer } from "../renderers/types";

/**
 * A node in the Agentick tree built by react-reconciler.
 * This is the "host instance" in React terminology.
 */
export interface AgentickNode {
  /** Component type (function, class, string for intrinsics, symbol for Fragment) */
  type: AgentickNodeType;

  /** Props passed to the component */
  props: Record<string, unknown>;

  /** Child nodes */
  children: AgentickNode[];

  /** Parent node (for traversal) */
  parent: AgentickNode | null;

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
export type AgentickNodeType =
  | string // Intrinsic elements
  | ((...args: unknown[]) => unknown) // Function components
  | { new (...args: unknown[]): unknown } // Class components
  | symbol; // Fragment

/**
 * The container (root) of the Agentick tree.
 */
export interface AgentickContainer {
  /** Root children */
  children: AgentickNode[];

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
 * Create a new AgentickNode.
 */
export function createNode(
  type: AgentickNodeType,
  props: Props,
  renderer: Renderer | null,
  key: string | number | null = null,
): AgentickNode {
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

/**
 * A text node in the Agentick tree.
 * Represents raw text content.
 */
export interface AgentickTextNode {
  /** Text content */
  text: string;

  /** Parent node */
  parent: AgentickNode | null;

  /** Index among siblings */
  index: number;

  /** Marker to distinguish from regular nodes */
  isTextNode: true;
}

/**
 * Create a text node.
 */
export function createTextNode(text: string): AgentickTextNode {
  return {
    text,
    parent: null,
    index: 0,
    isTextNode: true,
  };
}

/**
 * Check if a node is a text node.
 */
export function isTextNode(node: AgentickNode | AgentickTextNode): node is AgentickTextNode {
  return "isTextNode" in node && node.isTextNode === true;
}
