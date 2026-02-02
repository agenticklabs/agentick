import {
  type ExecutionHandle,
  type ExecutionMessage,
  type ExecutionStatus,
  type ExecutionType,
  type ExecutionMetrics,
  type ExecutionState,
  type SignalType,
  type SignalEvent,
} from "./execution-types";
import type { COMInput } from "../com/types";
import type { StreamEvent } from "./engine-events";
import { EventEmitter } from "node:events";
import {
  ProcedureGraph,
  ProcedureNode,
  EventBuffer,
  type ExecutionHandle as KernelExecutionHandle,
} from "@tentickle/kernel";
import { Context } from "@tentickle/kernel";
import { AbortError, StateError } from "@tentickle/shared";
import { COM } from "../com/object-model";

/**
 * Concrete implementation of ExecutionHandle
 * Also implements Kernel's ExecutionHandle<TOutput> for Procedure compatibility
 */
export class ExecutionHandleImpl
  extends EventEmitter
  implements ExecutionHandle, KernelExecutionHandle<COMInput>
{
  public readonly pid: string;
  public readonly parentPid?: string;
  public readonly rootPid: string;
  public readonly type: ExecutionType;
  public status: ExecutionStatus;
  public readonly startedAt: Date;
  public completedAt?: Date;

  // Kernel ExecutionHandle<TOutput> compatibility
  public readonly result: Promise<COMInput>; // Maps to completionPromise
  /**
   * Event buffer for streaming execution events.
   * Supports dual consumption - multiple iterators can independently consume all events.
   * This is also exposed as `events` for Kernel ExecutionHandle compatibility.
   */
  public readonly eventBuffer: EventBuffer<StreamEvent>;
  public readonly events: EventBuffer<StreamEvent>; // Alias for eventBuffer (Kernel compat)
  public traceId: string = ""; // Set by handle factory

  private resultValue?: COMInput; // Actual result value (set when complete)
  private error?: Error;
  private cancelController?: AbortController;
  private completionPromise: Promise<COMInput>;
  private completionResolve?: (value: COMInput) => void;
  private completionReject?: (error: Error) => void;
  private comInstance?: COM;
  private streamIterator?: AsyncIterable<StreamEvent>;
  private tickCount: number = 0;
  private session?: {
    queue: {
      exec: (message: Omit<ExecutionMessage, "id" | "timestamp">) => Promise<void>;
    };
  };
  private shutdownHooks: Array<() => Promise<void> | void> = [];
  private parentHandle?: ExecutionHandle;
  private procedureGraph?: ProcedureGraph; // Procedure graph for this execution
  private _abortEmitted: boolean = false; // Track if abort signal was already emitted (before listeners were set up)
  private _listenersSetup: boolean = false; // Track if abort listeners have been set up in iterateTicks

  constructor(
    pid: string,
    rootPid: string,
    type: ExecutionType,
    parentPid?: string,
    parentHandle?: ExecutionHandle,
  ) {
    super();
    // Increase max listeners to handle child execution scenarios with multiple abort listeners
    this.setMaxListeners(20);
    this.pid = pid;
    this.rootPid = rootPid;
    this.type = type;
    this.parentPid = parentPid;
    this.status = "running";
    this.startedAt = new Date();
    this.parentHandle = parentHandle;

    // Create completion promise
    this.completionPromise = new Promise<COMInput>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
    // Prevent unhandled promise rejection when fail() or cancel() is called but no one is waiting
    // This catch handler ensures that rejections are always handled, even if waitForCompletion() is never called
    this.completionPromise.catch((_error) => {
      // Error is stored in this.error and will be returned by waitForCompletion
      // if called later. This catch prevents Node.js from complaining about
      // unhandled rejections when we use fail() or cancel() internally.
      // Silently handle the rejection - it's expected behavior
    });

    // Kernel ExecutionHandle<TOutput> compatibility
    // result maps to completionPromise (Kernel expects Promise<TOutput>)
    this.result = this.completionPromise;
    // EventBuffer for dual consumption support (create first)
    this.eventBuffer = new EventBuffer<StreamEvent>();
    // events is alias for eventBuffer (Kernel expects EventBuffer<TEvent>)
    this.events = this.eventBuffer;
    // Forward events from EventEmitter (this) to EventBuffer
    this.on("*", (event: StreamEvent) => {
      this.eventBuffer.push(event);
    });

    // Note: The Kernel's procedure may pass a resultPromise via linkKernelResult()
    // which will connect to complete/fail when it settles

    // For child executions: monitor parent status
    if (type === "child" && parentHandle) {
      // If parent has already completed, child runs independently
      // Clear any abort flags that might have been set by propagated signals from completed parent
      // Also mark listeners as setup to prevent wasAbortEmitted() from returning true
      // for aborts that occurred before the child started executing
      if (parentHandle.status !== "running") {
        this._abortEmitted = false; // Clear flag - parent completed, child runs independently
        this._listenersSetup = true; // Mark as setup to ignore pre-execution aborts
      }
      this.setupParentStatusMonitor(parentHandle);
    }
  }

  /**
   * Link the Kernel's result promise to this handle.
   * When the promise resolves, calls complete(). When it rejects, calls fail().
   * This connects the Kernel's procedure execution to the Engine's handle lifecycle.
   */
  linkKernelResult(kernelResultPromise: Promise<COMInput>): void {
    kernelResultPromise.then(
      (result) => {
        this.complete(result);
      },
      (error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  /**
   * Monitor parent status (child executions only)
   * When parent fails or is cancelled AFTER child is created, abort child.
   *
   * Note: If parent completes successfully, child continues running independently.
   * If parent is already completed/failed when child is created, the child runs independently.
   */
  private setupParentStatusMonitor(parent: ExecutionHandle): void {
    // Only monitor if parent is still running
    // If parent is already completed/failed, child runs independently
    if (parent.status !== "running") {
      return;
    }

    // Only abort child if parent fails or is cancelled - NOT on successful completion
    // Child executions should continue running after parent completes successfully
    parent.once("failed", () => {
      if (this.status === "running") {
        this.emitSignal("abort", "Parent execution failed", {
          propagatedFrom: parent.pid,
        });
      }
    });

    // Monitor cancellation via abort signal (parent.cancel() emits abort)
    parent.once("abort", () => {
      if (this.status === "running") {
        this.emitSignal("abort", "Parent execution cancelled", {
          propagatedFrom: parent.pid,
        });
      }
    });

    // Also monitor via waitForCompletion as fallback
    // Only abort on failure/cancellation, not on successful completion
    if (parent.status === "running") {
      parent.waitForCompletion().catch((_error) => {
        if (this.status === "running") {
          this.emitSignal("abort", "Parent execution failed", {
            propagatedFrom: parent.pid,
          });
        }
      });
    }
  }

  /**
   * Set the stream iterator for this execution
   */
  setStreamIterator(iterator: AsyncIterable<StreamEvent>): void {
    this.streamIterator = iterator;
  }

  /**
   * Set the cancel controller
   */
  setCancelController(controller: AbortController): void {
    this.cancelController = controller;
    // Setup listener for abort signal
    // Only add listener if signal is not already aborted
    // Note: This listener will emit when controller is aborted externally
    // When cancel() is called, it emits the signal first, then aborts the controller
    // So this listener acts as a fallback for external aborts
    if (!controller.signal.aborted) {
      controller.signal.addEventListener("abort", () => {
        // Only emit if we're still running (avoid duplicate if cancel() was called)
        if (this.status === "running") {
          this.emitSignal("abort", "Execution cancelled");
        }
      });
    }
    // Note: If signal is already aborted when setCancelController is called,
    // we don't need to do anything here because:
    // 1. For normal executions, the controller is always fresh (not aborted)
    // 2. For forks, the merged signal (which may be aborted) is passed via context,
    //    not via setCancelController. The abort will be detected via ctx.signal.aborted
    //    in iterateTicks.
  }

  /**
   * Get the cancel signal (if cancel controller is set)
   */
  getCancelSignal(): AbortSignal | undefined {
    // Don't return signal if execution has completed or failed
    // This prevents forks from inheriting aborted signals from completed parents
    if (this.status !== "running" && this.status !== "cancelled") {
      return undefined;
    }
    return this.cancelController?.signal;
  }

  /**
   * Increment tick count
   */
  incrementTick(): void {
    this.tickCount++;
  }

  /**
   * Mark execution as completed
   */
  complete(result: COMInput): void {
    if (this.status !== "running") {
      return;
    }

    this.status = "completed";
    this.completedAt = new Date();
    this.resultValue = result;

    // Close the event buffer
    this.eventBuffer.close();

    // Emit completion event
    this.emit("completed", result);

    if (this.completionResolve) {
      const resolve = this.completionResolve;
      // Clear resolve function to prevent double-resolution
      this.completionResolve = undefined;
      this.completionReject = undefined; // Also clear reject since we're resolving
      resolve(result);
    }
  }

  /**
   * Mark execution as failed
   */
  fail(error: Error): void {
    if (this.status !== "running") {
      return;
    }

    this.status = "failed";
    this.completedAt = new Date();
    this.error = error;

    // Close the event buffer with error
    this.eventBuffer.error(error);

    // Emit failure event
    this.emit("failed", error);

    if (this.completionReject) {
      const reject = this.completionReject;
      // Clear reject function to prevent double-rejection
      this.completionReject = undefined;
      this.completionResolve = undefined; // Also clear resolve since we're rejecting

      // Reject the promise - the catch handler in constructor will prevent unhandled rejection
      try {
        reject(error);
      } catch (_rejectionError) {
        // Ignore errors if promise already settled (this is expected and harmless)
        // The promise's catch handler will still prevent unhandled rejection
      }
    }
  }

  /**
   * Wait for execution to complete
   */
  async waitForCompletion(options?: { timeout?: number }): Promise<COMInput> {
    if (!this.completionPromise) {
      throw new StateError(
        "uninitialized",
        "initialized",
        "Execution handle not properly initialized",
      );
    }

    if (options?.timeout) {
      return Promise.race([
        this.completionPromise,
        new Promise<COMInput>((_, reject) => {
          setTimeout(() => {
            reject(
              new AbortError(
                `Execution ${this.pid} timed out after ${options.timeout}ms`,
                "ABORT_TIMEOUT",
                { pid: this.pid, timeoutMs: options.timeout },
              ),
            );
          }, options.timeout);
        }),
      ]);
    }

    return this.completionPromise;
  }

  /**
   * Cancel the execution (triggers abort signal)
   */
  cancel(reason?: string): void {
    if (this.status !== "running") {
      return;
    }

    this.status = "cancelled";
    this.completedAt = new Date();

    // Close the event buffer
    this.eventBuffer.close();

    // Emit abort signal first (this will propagate to children)
    // Note: We emit before aborting the controller to avoid duplicate signals
    // The controller's abort listener will also emit, but we check for already-aborted status
    this.emitSignal("abort", reason || "Execution cancelled");

    // Abort the controller (this will trigger its listener, but we've already emitted)
    if (this.cancelController && !this.cancelController.signal.aborted) {
      this.cancelController.abort();
    }

    // Reject the completion promise if it hasn't been settled yet
    // Reject synchronously - callers should handle the rejection
    // Clear reject function immediately to prevent double-rejection
    if (this.completionReject) {
      const reject = this.completionReject;
      const error = new AbortError(reason || "Execution cancelled");
      this.completionReject = undefined;
      this.completionResolve = undefined; // Also clear resolve since we're rejecting

      // Store error for waitForCompletion() if called later
      this.error = error;

      // Reject the promise - the catch handler in constructor will prevent unhandled rejection
      try {
        reject(error);
      } catch (_rejectionError) {
        // Ignore errors if promise already settled (this is expected and harmless)
        // The promise's catch handler will still prevent unhandled rejection
      }
    }
  }

  /**
   * Emit signal for this execution
   */
  emitSignal(signal: SignalType, reason?: string, metadata?: Record<string, any>): void {
    const event: SignalEvent = {
      type: signal,
      source: "execution",
      pid: this.pid,
      parentPid: this.parentPid,
      reason,
      timestamp: Date.now(),
      metadata,
    };

    // Track if abort was emitted BEFORE listeners were set up
    // Only set flag if listeners haven't been set up yet (to catch early aborts)
    // Once listeners are set up, they will catch all aborts, so we don't need the flag
    if (signal === "abort" && !this._listenersSetup) {
      this._abortEmitted = true;
    }

    this.emit(signal, event);

    // If abort signal, trigger cancel controller (if not already aborted)
    // Note: cancel() already aborts the controller, so this is mainly for external signals
    if (signal === "abort" && this.cancelController && !this.cancelController.signal.aborted) {
      this.cancelController.abort();
    }
  }

  /**
   * Mark that abort listeners have been set up in iterateTicks.
   * Called by iterateTicks after setting up listeners to prevent false positives.
   * Once listeners are set up, future emitSignal('abort') calls won't set _abortEmitted,
   * and wasAbortEmitted() will return false (since it checks !_listenersSetup).
   */
  markListenersSetup(): void {
    this._listenersSetup = true;
    // Clear the flag for cleanup (redundant since wasAbortEmitted() checks !_listenersSetup,
    // but keeps the state clean)
    this._abortEmitted = false;
  }

  /**
   * Check if abort signal was already emitted (before listeners were set up)
   * Used by iterateTicks to detect early abort signals
   *
   * Note: Only checks if THIS execution emitted an abort via emitSignal('abort'),
   * not if the signal is aborted (which could be from a parent signal in forks).
   * Signal aborted state is checked separately in iterateTicks via ctx.signal.aborted.
   *
   * This should only be checked ONCE at the start of iterateTicks, before listeners are set up.
   */
  wasAbortEmitted(): boolean {
    // Only check the flag - don't check status because status might be set by cancel()
    // which is called AFTER abort is detected, creating a circular dependency
    // Also only return true if listeners haven't been set up yet
    return !this._listenersSetup && this._abortEmitted;
  }

  /**
   * Register graceful shutdown hook for this execution
   */
  onShutdown(handler: () => Promise<void> | void): () => void {
    this.shutdownHooks.push(handler);
    return () => {
      const index = this.shutdownHooks.indexOf(handler);
      if (index > -1) {
        this.shutdownHooks.splice(index, 1);
      }
    };
  }

  /**
   * Run shutdown hooks (called before aborting)
   */
  async runShutdownHooks(): Promise<void> {
    for (const hook of this.shutdownHooks) {
      try {
        await hook();
      } catch (error) {
        console.error(`Error in shutdown hook for execution ${this.pid}:`, error);
      }
    }
  }

  /**
   * Get execution result
   */
  getResult(): COMInput | undefined {
    return this.resultValue;
  }

  // ============================================================================
  // PromiseLike<COMInput> implementation
  // ============================================================================

  /**
   * PromiseLike implementation - allows `await handle` to resolve to COMInput
   */
  then<TResult1 = COMInput, TResult2 = never>(
    onfulfilled?: ((value: COMInput) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.result.then(onfulfilled, onrejected);
  }

  /**
   * Catch handler for errors - same as `.then(undefined, onrejected)`
   */
  catch<TResult2 = never>(
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<COMInput | TResult2> {
    return this.result.catch(onrejected);
  }

  // ============================================================================
  // AsyncIterable<StreamEvent> implementation
  // ============================================================================

  /**
   * AsyncIterable implementation - allows `for await (const event of handle)`
   * Delegates to the stream iterator if available.
   */
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.streamIterator) {
      // Return an empty iterator if no stream is set
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          return { value: undefined as any, done: true };
        },
      };
    }
    return this.streamIterator[Symbol.asyncIterator]();
  }

  // ============================================================================
  // Abort method for Kernel ExecutionHandle compatibility
  // ============================================================================

  /**
   * Abort the execution (alias for cancel)
   * This is the Kernel ExecutionHandle interface method.
   */
  abort(reason?: string): void {
    this.cancel(reason);
  }

  /**
   * Kernel ExecutionHandle<TOutput> compatibility
   * Maps status to Kernel's status type
   */
  getStatus(): "running" | "completed" | "failed" | "cancelled" {
    // Map 'pending' to 'running' for Kernel compatibility
    return this.status === "pending" ? "running" : this.status;
  }

  /**
   * Stream execution events
   */
  stream(): AsyncIterable<StreamEvent> {
    if (!this.streamIterator) {
      throw new StateError("no_stream", "streaming", "Stream iterator not set");
    }

    return this.streamIterator;
  }

  /**
   * Get execution metrics
   */
  getMetrics(): ExecutionMetrics {
    const duration = this.completedAt
      ? this.completedAt.getTime() - this.startedAt.getTime()
      : Date.now() - this.startedAt.getTime();

    return {
      pid: this.pid,
      parentPid: this.parentPid,
      rootPid: this.rootPid,
      type: this.type,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      duration,
      tickCount: this.tickCount,
      error: this.error
        ? {
            message: this.error.message,
            phase: undefined, // TODO: Track phase
          }
        : undefined,
    };
  }

  /**
   * Get execution duration
   */
  getDuration(): number {
    const endTime = this.completedAt || new Date();
    return endTime.getTime() - this.startedAt.getTime();
  }

  /**
   * Create execution state for persistence
   */
  toState(component: any, input: any, currentTick: number, previous?: COMInput): ExecutionState {
    return {
      pid: this.pid,
      parentPid: this.parentPid,
      rootPid: this.rootPid,
      type: this.type,
      status: this.status,
      input,
      component,
      currentTick,
      previous,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error
        ? {
            message: this.error.message,
            stack: this.error.stack,
          }
        : undefined,
    };
  }

  /**
   * Set procedure graph for this execution
   * Called by Engine when execution starts to link execution to its procedure graph
   */
  setProcedureGraph(graph: ProcedureGraph): void {
    this.procedureGraph = graph;
  }

  /**
   * Get procedure graph for this execution
   * Returns undefined if no procedures were executed in this execution's context
   */
  getProcedureGraph(): ProcedureGraph | undefined {
    // If we have a stored reference, return it
    if (this.procedureGraph) {
      return this.procedureGraph;
    }

    // Otherwise, try to get it from current context (for active executions)
    // This allows accessing procedure graph even if execution is still running
    const ctx = Context.tryGet();
    if (ctx?.procedureGraph) {
      // Store reference for future access
      this.procedureGraph = ctx.procedureGraph;
      return ctx.procedureGraph;
    }

    return undefined;
  }

  /**
   * Get aggregated metrics from all procedures in this execution
   * Includes both execution-level metrics and procedure-level metrics
   */
  getProcedureMetrics(): Record<string, number> {
    const graph = this.getProcedureGraph();
    if (!graph) {
      return {};
    }

    // Aggregate metrics from all procedure nodes
    const aggregated: Record<string, number> = {};
    const allNodes = graph.getAllNodes();

    for (const node of allNodes) {
      for (const [key, value] of Object.entries(node.metrics)) {
        aggregated[key] = (aggregated[key] || 0) + value;
      }
    }

    return aggregated;
  }

  /**
   * Get procedure nodes for this execution
   */
  getProcedureNodes(): ProcedureNode[] {
    const graph = this.getProcedureGraph();
    return graph ? graph.getAllNodes() : [];
  }

  /**
   * Get root procedure node (if any procedures were executed)
   */
  getRootProcedureNode(): ProcedureNode | undefined {
    const graph = this.getProcedureGraph();
    if (!graph) {
      return undefined;
    }

    // Find root procedure (no parent)
    const allNodes = graph.getAllNodes();
    return allNodes.find((node) => !node.parentPid);
  }

  setComInstance(com: COM): void {
    this.comInstance = com;
  }

  /**
   * Set the compile session for message sending.
   * Called by Engine when execution starts.
   */
  setSession(session: {
    queue: {
      exec: (message: Omit<ExecutionMessage, "id" | "timestamp">) => Promise<void>;
    };
  }): void {
    this.session = session;
  }

  /**
   * Send a message to the running execution.
   *
   * The message is delivered immediately to component onMessage hooks,
   * then queued for availability in TickState.queuedMessages.
   *
   * @param message The message to send (id and timestamp are auto-generated)
   * @throws Error if execution is not running or no active session
   */
  async send(message: Omit<ExecutionMessage, "id" | "timestamp">): Promise<void> {
    if (this.status !== "running") {
      throw new StateError(
        this.status,
        "running",
        `Cannot send message to ${this.status} execution`,
      );
    }

    if (!this.session) {
      throw new StateError(
        "no_session",
        "active_session",
        "No active session - message cannot be sent",
      );
    }

    await this.session.queue.exec(message);
  }

  getComInstance(): COM | undefined {
    return this.comInstance;
  }
}
