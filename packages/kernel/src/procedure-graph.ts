/**
 * Procedure status
 */
export type ProcedureStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Procedure node stored in the graph
 */
export class ProcedureNode {
  public readonly pid: string;
  public readonly parentPid?: string;
  public readonly name?: string;
  public status: ProcedureStatus;
  public readonly startedAt: Date;
  public completedAt?: Date;
  public error?: Error;
  public metadata?: Record<string, any>;
  public readonly graph: ProcedureGraph;

  // Metrics stored in node (not context)
  public metrics: Record<string, number> = {};

  // Execution boundary fields - tracks which logical execution this procedure belongs to
  public readonly executionId: string;
  public readonly isExecutionBoundary: boolean;
  public readonly executionType?: string;

  constructor(
    graph: ProcedureGraph,
    pid: string,
    parentPid?: string,
    name?: string,
    metadata?: Record<string, any>,
    executionId?: string,
    isExecutionBoundary?: boolean,
    executionType?: string,
  ) {
    this.graph = graph;
    this.pid = pid;
    this.parentPid = parentPid;
    this.name = name;
    this.status = "running";
    this.startedAt = new Date();
    this.metadata = metadata;
    // Execution boundary: defaults to self as execution if not provided
    this.executionId = executionId ?? pid;
    this.isExecutionBoundary = isExecutionBoundary ?? false;
    this.executionType = executionType;
  }

  /**
   * Add metric value (accumulates)
   */
  addMetric(key: string, value: number): void {
    this.metrics[key] = (this.metrics[key] || 0) + value;
  }

  /**
   * Set metric value (overwrites)
   */
  setMetric(key: string, value: number): void {
    this.metrics[key] = value;
  }

  /**
   * Get metric value
   */
  getMetric(key: string): number {
    return this.metrics[key] || 0;
  }

  /**
   * Merge metrics from another node (for propagation)
   */
  mergeMetrics(sourceMetrics: Record<string, number>): void {
    for (const [key, value] of Object.entries(sourceMetrics)) {
      this.metrics[key] = (this.metrics[key] || 0) + value;
    }
  }

  complete(): void {
    this.status = "completed";
    this.completedAt = new Date();
  }

  fail(error: Error): void {
    this.status = "failed";
    this.completedAt = new Date();
    this.error = error;
  }

  cancel(): void {
    this.status = "cancelled";
    this.completedAt = new Date();
  }

  /**
   * Get duration in milliseconds (undefined if not completed)
   */
  get durationMs(): number | undefined {
    if (!this.completedAt) {
      return undefined;
    }
    return this.completedAt.getTime() - this.startedAt.getTime();
  }

  getParentNode(): ProcedureNode | undefined {
    return this.parentPid ? this.graph.get(this.parentPid) : undefined;
  }

  getChildrenNodes(): ProcedureNode[] {
    return this.graph.getChildNodes(this.pid);
  }

  hasAncestor(predicate: (node: ProcedureNode) => boolean): boolean {
    return this.graph.hasAncestor(this.pid, predicate);
  }
}

/**
 * Procedure graph for tracking parent-child relationships
 */
export class ProcedureGraph {
  private procedures = new Map<string, ProcedureNode>();
  private childrenMap = new Map<string, Set<string>>(); // parentPid -> Set<childPid>
  private rootPid?: string; // Cached root procedure PID

  /**
   * Register a new procedure
   *
   * @param pid Procedure ID
   * @param parentPid Parent procedure ID (undefined for root)
   * @param name Procedure name (e.g., 'model:generate', 'tool:run')
   * @param metadata Optional metadata
   * @param executionId Execution ID this procedure belongs to
   * @param isExecutionBoundary Whether this procedure is an execution entry point
   * @param executionType Type of execution (derived from procedure name prefix)
   */
  register(
    pid: string,
    parentPid?: string,
    name?: string,
    metadata?: Record<string, any>,
    executionId?: string,
    isExecutionBoundary?: boolean,
    executionType?: string,
  ): ProcedureNode {
    const node = new ProcedureNode(
      this,
      pid,
      parentPid,
      name,
      metadata,
      executionId,
      isExecutionBoundary,
      executionType,
    );
    this.procedures.set(pid, node);

    // Track parent-child relationship
    if (parentPid) {
      if (!this.childrenMap.has(parentPid)) {
        this.childrenMap.set(parentPid, new Set());
      }
      this.childrenMap.get(parentPid)!.add(pid);
    } else {
      // This is a root procedure - cache it
      this.rootPid = pid;
    }

    return node;
  }

  /**
   * Get procedure node by PID
   */
  get(pid: string): ProcedureNode | undefined {
    return this.procedures.get(pid);
  }

  /**
   * Get parent PID
   */
  getParent(pid: string): string | undefined {
    return this.procedures.get(pid)?.parentPid;
  }

  /**
   * Get parent node
   */
  getParentNode(pid: string): ProcedureNode | undefined {
    const node = this.procedures.get(pid);
    return node?.parentPid ? this.procedures.get(node.parentPid) : undefined;
  }

  /**
   * Get child procedure PIDs
   */
  getChildren(parentPid: string): string[] {
    const childPids = this.childrenMap.get(parentPid);
    return childPids ? Array.from(childPids) : [];
  }

  /**
   * Get child procedure nodes
   */
  getChildNodes(parentPid: string): ProcedureNode[] {
    return this.getChildren(parentPid)
      .map((pid) => this.procedures.get(pid))
      .filter((node): node is ProcedureNode => node !== undefined);
  }

  /**
   * Propagate metrics from child to parent
   */
  propagateMetrics(childPid: string): void {
    const childNode = this.procedures.get(childPid);
    if (!childNode || !childNode.parentPid) {
      return;
    }

    const parentNode = this.procedures.get(childNode.parentPid);
    if (parentNode) {
      parentNode.mergeMetrics(childNode.metrics);
    }
  }

  /**
   * Update procedure status
   */
  updateStatus(pid: string, status: ProcedureStatus, error?: Error): void {
    const node = this.procedures.get(pid);
    if (!node) {
      return;
    }

    if (status === "completed") {
      node.complete();
      // Propagate metrics to parent on completion
      this.propagateMetrics(pid);
    } else if (status === "failed" && error) {
      node.fail(error);
      // Still propagate metrics even on failure
      this.propagateMetrics(pid);
    } else if (status === "cancelled") {
      node.cancel();
    } else {
      node.status = status;
    }
  }

  /**
   * Clear all procedures
   */
  clear(): void {
    this.procedures.clear();
    this.childrenMap.clear();
    this.rootPid = undefined;
  }

  /**
   * Get the root procedure node (O(1) lookup)
   */
  getRoot(): ProcedureNode | undefined {
    return this.rootPid ? this.procedures.get(this.rootPid) : undefined;
  }

  /**
   * Get the root procedure PID
   */
  getRootPid(): string | undefined {
    return this.rootPid;
  }

  /**
   * Get all procedure nodes
   */
  getAllNodes(): ProcedureNode[] {
    return Array.from(this.procedures.values());
  }

  /**
   * Get count of procedures
   */
  getCount(): number {
    return this.procedures.size;
  }

  /**
   * Check if any ancestor (parent chain) matches a predicate
   * Traverses up the parent chain starting from the given PID
   *
   * @param pid Starting procedure PID
   * @param predicate Function to test each ancestor node
   * @returns True if any ancestor matches, false otherwise
   */
  hasAncestor(pid: string, predicate: (node: ProcedureNode) => boolean): boolean {
    const node = this.procedures.get(pid);
    if (!node) {
      return false;
    }

    // Check current node
    if (predicate(node)) {
      return true;
    }

    // Traverse up parent chain
    let currentNode = node;
    while (currentNode) {
      const parentNode = currentNode.getParentNode();
      if (!parentNode) {
        break;
      }

      if (predicate(parentNode)) {
        return true;
      }

      currentNode = parentNode;
    }

    return false;
  }

  /**
   * Check if any ancestor has a specific procedure name
   * Useful for determining if a procedure was called by Engine vs direct application call
   *
   * @param pid Starting procedure PID
   * @param name Procedure name to search for (e.g., 'engine:execute', 'engine:stream')
   * @returns True if any ancestor has the specified name
   */
  hasAncestorWithName(pid: string, name: string): boolean {
    return this.hasAncestor(pid, (node) => node.name === name);
  }
}
