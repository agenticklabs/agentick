/**
 * V2 Fiber Compiler
 *
 * Uses react-reconciler to build a TentickleNode tree from React elements.
 * With React's native JSX runtime, elements are already React elements -
 * no conversion needed.
 */

import React from "react";

// Helper for createElement
const h = React.createElement;

import {
  createContainer,
  createRoot,
  updateContainer,
  flushSync,
  flushPassiveEffects,
  type FiberRoot,
  type TentickleContainer,
} from "../reconciler";
import { collect } from "./collector";
import type { CompiledStructure, CompileResult } from "./types";
import { createEmptyCompiledStructure } from "./types";
import {
  TentickleProvider,
  createRuntimeStore,
  storeHasPendingData,
  storeResolvePendingData,
  storeRunTickStartCallbacks,
  storeRunTickEndCallbacks,
  storeRunAfterCompileCallbacks,
  storeClearLifecycleCallbacks,
  storeClearDataCache,
  storeGetSerializableDataCache,
  storeSetDataCache,
  type RuntimeStore,
  type SerializableCacheEntry,
  // Message context
  createMessageStore,
  MessageProvider,
  type MessageStore,
} from "../hooks";
import type { ExecutionMessage } from "../engine/execution-types";
import type { Renderer } from "../renderers/types";
import { markdownRenderer } from "../renderers";
import type { COM } from "../com/object-model";
import type { TickState } from "../component/component";

export interface FiberCompilerConfig {
  dev?: boolean;
  maxCompileIterations?: number;
}

export interface ReconcileOptions {
  tickState?: TickState;
}

/**
 * Serialized hook state for devtools.
 */
export interface SerializedHook {
  index: number;
  type: string;
  value: unknown;
  deps?: unknown[];
  status?: string;
}

/**
 * Serialized fiber node for debugging/devtools.
 * Matches the FiberNode interface expected by devtools UI.
 */
export interface SerializedFiberNode {
  id: string;
  type: string;
  key: string | number | null;
  props: Record<string, unknown>;
  hooks: SerializedHook[];
  children: SerializedFiberNode[];
  _summary?: string;
}

/**
 * Serialized hook state for hibernation.
 */
export interface SerializedHookState {
  index: number;
  type: string;
  value: unknown;
}

/**
 * Hook type for serialization.
 */
export type HookType = "state" | "reducer" | "ref" | "memo" | "callback" | "effect" | "context";

/**
 * Summary of the fiber tree for debugging.
 */
export interface FiberSummary {
  componentCount: number;
  hookCount: number;
  effectCount: number;
  depth: number;
  /** Hook count by type (empty in v2 since React manages hooks internally) */
  hooksByType: Partial<Record<HookType, number>>;
}

type Phase =
  | "idle"
  | "tickStart"
  | "render"
  | "compile"
  | "tickEnd"
  | "mount"
  | "complete"
  | "unmount";

/**
 * V2 FiberCompiler - uses react-reconciler internally.
 *
 * This maintains API compatibility with v1 FiberCompiler so Session
 * can use it as a drop-in replacement.
 */
export class FiberCompiler {
  // React reconciler state
  private container: TentickleContainer;
  private root: FiberRoot;

  // Per-session runtime store (isolated state)
  private runtimeStore: RuntimeStore;

  // Message store for useOnMessage/useQueuedMessages
  private messageStore: MessageStore;

  // Context
  private com: COM;
  private tickState: TickState | null = null;
  private rootElement: React.ReactNode | null = null;

  // Config
  private config: FiberCompilerConfig;

  // Phase tracking
  private currentPhase: Phase = "idle";
  private isRendering = false;

  // Recompile tracking
  private recompileRequested = false;
  private recompileReasons: string[] = [];

  // Reconciliation callback (for reactive model)
  private onScheduleReconcile?: (reason?: string) => void;

  constructor(
    com: COM,
    _hookRegistry?: unknown, // ComponentHookRegistry - not used in v2
    config: FiberCompilerConfig = {},
  ) {
    this.com = com;
    this.config = {
      dev: config.dev ?? process.env.NODE_ENV === "development",
      maxCompileIterations: config.maxCompileIterations ?? 10,
    };

    // Create isolated runtime store for this compiler/session
    this.runtimeStore = createRuntimeStore();

    // Create message store for useOnMessage/useQueuedMessages
    this.messageStore = createMessageStore();

    // Create the render container and root
    this.container = createContainer(markdownRenderer);
    this.root = createRoot(this.container);

    // Wire up COM's requestRecompile to our tracking
    const originalRequestRecompile = com.requestRecompile.bind(com);
    com.requestRecompile = (reason?: string) => {
      this.recompileRequested = true;
      if (reason) {
        this.recompileReasons.push(reason);
      }
      originalRequestRecompile(reason);
    };
  }

  // ============================================================
  // Public API - Compilation
  // ============================================================

  /**
   * Set the root element for this compiler.
   */
  setRoot(element: React.ReactNode): void {
    this.rootElement = element;
  }

  /**
   * Set the reconciliation schedule callback.
   */
  setReconcileCallback(callback: (reason?: string) => void): void {
    this.onScheduleReconcile = callback;
  }

  /**
   * Reconcile the tree (render phase only, no collection).
   * Used by reactive model for incremental updates.
   */
  async reconcile(element?: React.ReactNode, options: ReconcileOptions = {}): Promise<void> {
    const el = element ?? this.rootElement;
    if (!el) {
      throw new Error("No element to reconcile. Call setRoot() or pass element.");
    }

    if (options.tickState) {
      this.tickState = options.tickState;
    }

    this.isRendering = true;
    this.currentPhase = "render";
    setActiveCompiler(this);

    try {
      const maxAttempts = 10;
      let attempts = 0;

      // With React's native JSX runtime, el is already a React element
      const reactElement = el;

      while (attempts < maxAttempts) {
        attempts++;

        try {
          // Render with React
          // Wrap with MessageProvider for useOnMessage/useQueuedMessages
          try {
            flushSync(() => {
              updateContainer(
                h(
                  MessageProvider,
                  { store: this.messageStore },
                  h(
                    TentickleProvider,
                    {
                      com: this.com as any,
                      tickState: this.tickState as any, // Different TickState types are compatible
                      runtimeStore: this.runtimeStore,
                    },
                    reactElement,
                  ),
                ),
                this.root,
              );
            });
          } catch (flushError) {
            console.error("[FiberCompiler.reconcile] flushSync error:", flushError);
            throw flushError;
          }

          // Flush passive effects (useEffect callbacks) immediately.
          // In non-DOM environments, these don't auto-flush.
          // This ensures lifecycle hooks are registered before we call them.
          flushPassiveEffects();

          // If we get here without throwing, check for any pending data
          // that was triggered during render
          if (!storeHasPendingData(this.runtimeStore)) {
            // No pending data, we're done
            break;
          }

          // Resolve pending data and loop to re-render
          await storeResolvePendingData(this.runtimeStore);
        } catch (error) {
          // useData throws promises when data isn't cached.
          // The promise is added to pendingFetches before throwing.
          // Check if we have pending data to resolve.
          if (storeHasPendingData(this.runtimeStore)) {
            await storeResolvePendingData(this.runtimeStore);
            // Continue loop to retry render
          } else {
            // Not a data fetch issue, rethrow
            throw error;
          }
        }
      }

      if (attempts >= maxAttempts) {
        console.warn(`Reconcile hit max attempts (${maxAttempts})`);
      }
    } finally {
      this.isRendering = false;
      this.currentPhase = "idle";
      setActiveCompiler(null);
    }
  }

  /**
   * Collect the compiled structure from the current tree.
   * Used by reactive model after reconcile().
   */
  collect(): CompiledStructure {
    return collect(this.container);
  }

  /**
   * Compile element to CompiledStructure.
   * Single pass: reconcile + collect.
   */
  async compile(element: React.ReactNode, state: TickState): Promise<CompiledStructure> {
    this.tickState = state;
    this.currentPhase = "compile";

    try {
      await this.reconcile(element, { tickState: state });
      return this.collect();
    } finally {
      this.currentPhase = "idle";
    }
  }

  /**
   * Compile until stable (no more recompile requests).
   */
  async compileUntilStable(
    element: React.ReactNode,
    state: TickState,
    options: { maxIterations?: number } = {},
  ): Promise<CompileResult> {
    const maxIterations = options.maxIterations ?? this.config.maxCompileIterations ?? 10;

    this.tickState = state;
    this.recompileReasons = [];

    let compiled: CompiledStructure = createEmptyCompiledStructure();
    let iterations = 0;
    let stable = false;

    while (!stable && iterations < maxIterations) {
      iterations++;
      this.recompileRequested = false;

      // Compile
      compiled = await this.compile(element, state);

      // Run after-compile callbacks
      await this.notifyAfterCompile(compiled, state, {});

      // Check if stable
      if (!this.recompileRequested && !storeHasPendingData(this.runtimeStore)) {
        stable = true;
      }
    }

    return {
      compiled,
      iterations,
      forcedStable: !stable,
      recompileReasons: this.recompileReasons,
    };
  }

  // ============================================================
  // Lifecycle Notifications
  // ============================================================

  async notifyStart(): Promise<void> {
    // Nothing special in v2 - components use useEffect for mount
  }

  async notifyTickStart(state: TickState): Promise<void> {
    this.tickState = state;
    this.currentPhase = "tickStart";
    try {
      await storeRunTickStartCallbacks(this.runtimeStore);
    } finally {
      this.currentPhase = "idle";
    }
  }

  async notifyTickEnd(state: TickState): Promise<void> {
    this.tickState = state;
    this.currentPhase = "tickEnd";
    try {
      await storeRunTickEndCallbacks(this.runtimeStore);
    } finally {
      this.currentPhase = "idle";
    }
  }

  async notifyAfterCompile(
    compiled: CompiledStructure,
    _state: TickState,
    _ctx: unknown,
  ): Promise<void> {
    await storeRunAfterCompileCallbacks(this.runtimeStore, compiled);
  }

  async notifyComplete(_finalState: unknown): Promise<void> {
    this.currentPhase = "complete";
    // Nothing special in v2
    this.currentPhase = "idle";
  }

  async notifyError(_state: TickState): Promise<unknown> {
    // Return null = no recovery action
    return null;
  }

  async notifyOnMessage(message: ExecutionMessage, state: TickState): Promise<void> {
    // Update store with current context before dispatching
    this.messageStore.com = this.com as any;
    this.messageStore.tickState = state;
    this.messageStore.lastMessage = message;

    // Dispatch message to all handlers registered via useOnMessage
    const com = this.com;
    for (const handler of this.messageStore.handlers) {
      await handler(com as any, message, state);
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  async unmount(): Promise<void> {
    this.currentPhase = "unmount";
    try {
      // Clear the tree
      flushSync(() => {
        updateContainer(null, this.root);
      });

      // Flush any pending cleanup effects
      flushPassiveEffects();

      // Clear any remaining state
      storeClearLifecycleCallbacks(this.runtimeStore);
      storeClearDataCache(this.runtimeStore);
    } finally {
      this.currentPhase = "idle";
    }
  }

  // ============================================================
  // State Queries
  // ============================================================

  isRenderingNow(): boolean {
    return this.isRendering;
  }

  isInTickStart(): boolean {
    return this.currentPhase === "tickStart";
  }

  isInTickEnd(): boolean {
    return this.currentPhase === "tickEnd";
  }

  shouldSkipRecompile(): boolean {
    return (
      this.currentPhase === "tickStart" ||
      this.currentPhase === "tickEnd" ||
      this.currentPhase === "complete" ||
      this.currentPhase === "unmount" ||
      this.isRendering
    );
  }

  // ============================================================
  // Renderer
  // ============================================================

  setRenderer(renderer: Renderer): void {
    this.container.renderer = renderer;
  }

  // ============================================================
  // Hibernation Support
  // ============================================================

  /**
   * Get the runtime store for hibernation.
   */
  getRuntimeStore(): RuntimeStore {
    return this.runtimeStore;
  }

  /**
   * Get the data cache as a serializable object.
   */
  getSerializableDataCache(): Record<string, SerializableCacheEntry> {
    return storeGetSerializableDataCache(this.runtimeStore);
  }

  /**
   * Restore the data cache from a serializable object.
   */
  setDataCache(data: Record<string, SerializableCacheEntry>): void {
    storeSetDataCache(this.runtimeStore, data);
  }

  // ============================================================
  // Hydration Support (session.ts compatibility)
  // ============================================================

  private _hydrationData: unknown = null;
  private _isHydrating = false;

  /**
   * Set hydration data for restoring session state.
   */
  setHydrationData(data: unknown): void {
    this._hydrationData = data;
    this._isHydrating = true;

    // If data includes a serialized data cache, restore it
    if (data && typeof data === "object" && "dataCache" in data) {
      this.setDataCache((data as any).dataCache);
    }
  }

  /**
   * Complete the hydration process.
   */
  completeHydration(): void {
    this._isHydrating = false;
    this._hydrationData = null;
  }

  /**
   * Check if currently hydrating.
   */
  isHydratingNow(): boolean {
    return this._isHydrating;
  }

  // ============================================================
  // Debug/DevTools Support (session.ts compatibility)
  // ============================================================

  /**
   * Serialize the fiber tree for debugging/devtools.
   * In v2, we serialize the TentickleNode tree from the container.
   */
  serializeFiberTree(): SerializedFiberNode | null {
    if (this.container.children.length === 0) {
      return null;
    }

    let idCounter = 0;

    const serializeNode = (node: any, path: string): SerializedFiberNode => {
      const id = `node-${idCounter++}`;
      const typeName =
        typeof node.type === "string"
          ? node.type
          : typeof node.type === "function"
            ? node.type.name || "Anonymous"
            : typeof node.type === "symbol"
              ? node.type.description || "Symbol"
              : "Unknown";

      // Generate a human-readable summary for the node
      const summary =
        node.text != null
          ? `"${String(node.text).slice(0, 50)}${String(node.text).length > 50 ? "..." : ""}"`
          : undefined;

      return {
        id,
        type: typeName,
        key: node.key ?? null,
        props: { ...node.props },
        hooks: [], // React manages hooks internally; we don't have access to them
        children: (node.children || []).map((child: any, i: number) =>
          serializeNode(child, `${path}.${i}`),
        ),
        _summary: summary,
      };
    };

    // Return root as a fragment containing all children
    return {
      id: "root",
      type: "Fragment",
      key: null,
      props: {},
      hooks: [],
      children: this.container.children.map((child, i) => serializeNode(child, String(i))),
    };
  }

  /**
   * Get a summary of the fiber tree for debugging.
   */
  getFiberSummary(): FiberSummary {
    let componentCount = 0;
    let _depth = 0;
    let maxDepth = 0;

    const countNodes = (nodes: any[], currentDepth: number): void => {
      if (currentDepth > maxDepth) maxDepth = currentDepth;

      for (const node of nodes) {
        componentCount++;
        if (node.children && node.children.length > 0) {
          countNodes(node.children, currentDepth + 1);
        }
      }
    };

    countNodes(this.container.children, 1);

    return {
      componentCount,
      hookCount: 0, // React manages hooks internally, we don't track
      effectCount: 0, // React manages effects internally
      depth: maxDepth,
      hooksByType: {}, // React manages hooks internally, we don't track by type
    };
  }
}

/**
 * Create a V2 FiberCompiler.
 */
export function createFiberCompiler(
  com: COM,
  hookRegistry?: unknown,
  config?: FiberCompilerConfig,
): FiberCompiler {
  return new FiberCompiler(com, hookRegistry, config);
}

// ============================================================
// Compiler Bridge for Signals
// ============================================================
// These functions allow signals to detect render phase and
// request recompilation when state changes during render.

/**
 * Currently active compiler instance.
 * Set by FiberCompiler during render operations.
 */
let activeCompiler: FiberCompiler | null = null;

/**
 * Set the active compiler (used internally during render).
 * @internal
 */
export function setActiveCompiler(compiler: FiberCompiler | null): void {
  activeCompiler = compiler;
}

/**
 * Get the currently active compiler, if any.
 * Used by signals to request recompilation.
 */
export function getActiveCompiler(): FiberCompiler | null {
  return activeCompiler;
}

/**
 * Check if we're currently inside a compiler render phase.
 * Used by signals to detect state changes during render.
 */
export function isCompilerRendering(): boolean {
  return activeCompiler?.isRenderingNow() ?? false;
}

/**
 * Check if we should skip requesting recompilation.
 * Returns true during phases where recompile is unnecessary:
 * - tickStart: Render is about to happen anyway
 * - tickEnd: Current tick is done, next tick will see the update
 * - complete: Execution is complete, no more renders
 * - unmount: Component is being removed
 */
export function shouldSkipRecompile(): boolean {
  return activeCompiler?.shouldSkipRecompile() ?? true;
}
