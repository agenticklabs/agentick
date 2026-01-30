/** @jsxImportSource react */
/**
 * V2 Fiber Compiler
 *
 * Drop-in replacement for v1 FiberCompiler that uses react-reconciler internally.
 * Maintains the same API surface so Session doesn't need to change.
 */

import React from "react";
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
} from "../hooks";
import type { Renderer } from "../renderers/types";
import { markdownRenderer } from "../renderers";

// Types that would come from v1 (simplified for now)
interface COM {
  id: string;
  timeline: unknown[];
  state: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  requestRecompile(reason?: string): void;
}

interface TickState {
  tick: number;
  previous: unknown;
  current: unknown;
  stop(reason?: string): void;
  stopped: boolean;
  stopReason?: string;
}

interface FiberCompilerConfig {
  dev?: boolean;
  maxCompileIterations?: number;
}

interface ReconcileOptions {
  tickState?: TickState;
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

    try {
      const maxAttempts = 10;
      let attempts = 0;

      while (attempts < maxAttempts) {
        attempts++;

        try {
          // Render with React
          flushSync(() => {
            updateContainer(
              <TentickleProvider
                com={this.com as any}
                tickState={this.tickState!}
                runtimeStore={this.runtimeStore}
              >
                {el}
              </TentickleProvider>,
              this.root,
            );
          });

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

  async notifyOnMessage(_message: unknown, _state: TickState): Promise<void> {
    // Components can use effects to handle messages
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
