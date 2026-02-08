/**
 * Host Config for react-reconciler
 *
 * This defines how React interacts with our "host" environment.
 * Instead of DOM nodes, we build AgentickNode trees.
 */

import type ReactReconciler from "react-reconciler";
import type {
  AgentickNode,
  AgentickContainer,
  HostContext,
  Props,
  UpdatePayload,
  AgentickTextNode,
} from "./types";
import { createNode, createTextNode } from "./types";
import type { Renderer } from "../renderers/types";

// Component types that switch renderer context
const RENDERER_COMPONENTS = new Map<unknown, Renderer>();

/**
 * Register a component type as a renderer switcher.
 */
export function registerRendererComponent(type: unknown, renderer: Renderer): void {
  RENDERER_COMPONENTS.set(type, renderer);
}

/**
 * Check if a type is a registered renderer component.
 */
export function isRendererComponent(type: unknown): boolean {
  return RENDERER_COMPONENTS.has(type);
}

/**
 * Get the renderer for a component type.
 */
export function getRendererForComponent(type: unknown): Renderer | undefined {
  return RENDERER_COMPONENTS.get(type);
}

/**
 * The host config for react-reconciler 0.29.x.
 * Type parameters match @types/react-reconciler 0.28.x.
 */
export const hostConfig: ReactReconciler.HostConfig<
  string, // Type
  Props, // Props
  AgentickContainer, // Container
  AgentickNode, // Instance
  AgentickTextNode, // TextInstance
  never, // SuspenseInstance
  never, // HydratableInstance
  AgentickNode, // PublicInstance
  HostContext, // HostContext
  UpdatePayload, // UpdatePayload
  never, // ChildSet
  ReturnType<typeof setTimeout>, // TimeoutHandle
  -1 // NoTimeout
> = {
  // ============================================================
  // Mode Configuration
  // ============================================================

  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  isPrimaryRenderer: true,
  noTimeout: -1,

  // ============================================================
  // Instance Creation
  // ============================================================

  createInstance(
    type: string,
    props: Props,
    _rootContainer: AgentickContainer,
    hostContext: HostContext,
    _internalHandle: unknown,
  ): AgentickNode {
    const key = (props.key as string | number | null) ?? null;
    const { key: _k, children: _c, ...restProps } = props;
    return createNode(type, restProps, hostContext.renderer, key);
  },

  createTextInstance(
    text: string,
    _rootContainer: AgentickContainer,
    _hostContext: HostContext,
    _internalHandle: unknown,
  ): AgentickTextNode {
    return createTextNode(text);
  },

  // ============================================================
  // Tree Operations (Mutation Mode)
  // ============================================================

  appendChild(parent: AgentickNode, child: AgentickNode): void {
    child.parent = parent;
    child.index = parent.children.length;
    parent.children.push(child);
  },

  appendInitialChild(parent: AgentickNode, child: AgentickNode): void {
    child.parent = parent;
    child.index = parent.children.length;
    parent.children.push(child);
  },

  appendChildToContainer(container: AgentickContainer, child: AgentickNode): void {
    child.parent = null;
    child.index = container.children.length;
    container.children.push(child);
  },

  insertBefore(parent: AgentickNode, child: AgentickNode, beforeChild: AgentickNode): void {
    const index = parent.children.indexOf(beforeChild);
    if (index === -1) {
      parent.children.push(child);
    } else {
      parent.children.splice(index, 0, child);
    }
    child.parent = parent;
    parent.children.forEach((c, i) => (c.index = i));
  },

  insertInContainerBefore(
    container: AgentickContainer,
    child: AgentickNode,
    beforeChild: AgentickNode,
  ): void {
    const index = container.children.indexOf(beforeChild);
    if (index === -1) {
      container.children.push(child);
    } else {
      container.children.splice(index, 0, child);
    }
    child.parent = null;
    container.children.forEach((c, i) => (c.index = i));
  },

  removeChild(parent: AgentickNode, child: AgentickNode): void {
    const index = parent.children.indexOf(child);
    if (index !== -1) {
      parent.children.splice(index, 1);
      parent.children.forEach((c, i) => (c.index = i));
    }
    child.parent = null;
  },

  removeChildFromContainer(container: AgentickContainer, child: AgentickNode): void {
    const index = container.children.indexOf(child);
    if (index !== -1) {
      container.children.splice(index, 1);
      container.children.forEach((c, i) => (c.index = i));
    }
    child.parent = null;
  },

  clearContainer(container: AgentickContainer): void {
    container.children.length = 0;
  },

  // ============================================================
  // Context (for nested renderers)
  // ============================================================

  getRootHostContext(rootContainer: AgentickContainer): HostContext {
    return { renderer: rootContainer.renderer };
  },

  getChildHostContext(
    parentContext: HostContext,
    type: string,
    _rootContainer: AgentickContainer,
  ): HostContext {
    const renderer = RENDERER_COMPONENTS.get(type);
    if (renderer) {
      return { renderer };
    }
    return parentContext;
  },

  // ============================================================
  // Updates
  // ============================================================

  prepareUpdate(
    _instance: AgentickNode,
    _type: string,
    oldProps: Props,
    newProps: Props,
    _rootContainer: AgentickContainer,
    _hostContext: HostContext,
  ): UpdatePayload | null {
    if (shallowDiffers(oldProps, newProps)) {
      return { props: newProps };
    }
    return null;
  },

  commitUpdate(
    instance: AgentickNode,
    updatePayload: UpdatePayload,
    _type: string,
    _prevProps: Props,
    _nextProps: Props,
    _internalHandle: unknown,
  ): void {
    const { key: _k, children: _c, ...restProps } = updatePayload.props;
    instance.props = restProps;
  },

  commitTextUpdate(textInstance: AgentickTextNode, _oldText: string, newText: string): void {
    textInstance.text = newText;
  },

  // ============================================================
  // Finalization
  // ============================================================

  finalizeInitialChildren(
    _instance: AgentickNode,
    _type: string,
    _props: Props,
    _rootContainer: AgentickContainer,
    _hostContext: HostContext,
  ): boolean {
    return false;
  },

  prepareForCommit(_containerInfo: AgentickContainer): Record<string, unknown> | null {
    return null;
  },

  resetAfterCommit(_containerInfo: AgentickContainer): void {},

  // ============================================================
  // Misc Required Methods
  // ============================================================

  getPublicInstance(instance: AgentickNode): AgentickNode {
    return instance;
  },

  preparePortalMount(): void {},

  shouldSetTextContent(_type: string, _props: Props): boolean {
    return false;
  },

  // ============================================================
  // Scheduling
  // ============================================================

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,

  getCurrentEventPriority(): number {
    return 16; // DefaultEventPriority
  },

  getInstanceFromNode(): null {
    return null;
  },

  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},

  prepareScopeUpdate(): void {},
  getInstanceFromScope(): null {
    return null;
  },

  detachDeletedInstance(): void {},
};

/**
 * Shallow comparison of props objects.
 */
function shallowDiffers(a: Props, b: Props): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return true;

  for (const key of aKeys) {
    if (key === "children") continue;
    if (a[key] !== b[key]) return true;
  }

  return false;
}
