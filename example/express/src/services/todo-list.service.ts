/**
 * TodoList Service
 *
 * In-memory CRUD operations for todo items.
 * Keyed by sessionId to maintain per-session state.
 */

/**
 * A single todo item.
 */
export interface TodoItem {
  id: number;
  title: string;
  completed: boolean;
  createdAt: Date;
}

/**
 * Singleton service managing todo lists per session.
 */
class TodoListServiceImpl {
  private stores = new Map<string, Map<number, TodoItem>>();
  private counters = new Map<string, number>();

  private getStore(sessionId: string): Map<number, TodoItem> {
    if (!this.stores.has(sessionId)) {
      this.stores.set(sessionId, new Map());
      this.counters.set(sessionId, 0);
    }
    return this.stores.get(sessionId)!;
  }

  private nextId(sessionId: string): number {
    const current = this.counters.get(sessionId) ?? 0;
    const next = current + 1;
    this.counters.set(sessionId, next);
    return next;
  }

  /**
   * List all todos for a session.
   */
  list(sessionId: string): TodoItem[] {
    const store = this.getStore(sessionId);
    return Array.from(store.values()).sort((a, b) => a.id - b.id);
  }

  /**
   * Get a single todo by ID.
   */
  get(sessionId: string, id: number): TodoItem | undefined {
    return this.getStore(sessionId).get(id);
  }

  /**
   * Create a new todo.
   */
  create(sessionId: string, title: string): TodoItem {
    const store = this.getStore(sessionId);
    const item: TodoItem = {
      id: this.nextId(sessionId),
      title,
      completed: false,
      createdAt: new Date(),
    };
    store.set(item.id, item);
    return item;
  }

  /**
   * Update a todo's title or completed status.
   */
  update(
    sessionId: string,
    id: number,
    updates: { title?: string; completed?: boolean },
  ): TodoItem | undefined {
    const store = this.getStore(sessionId);
    const item = store.get(id);
    if (!item) return undefined;

    if (updates.title !== undefined) {
      item.title = updates.title;
    }
    if (updates.completed !== undefined) {
      item.completed = updates.completed;
    }
    return item;
  }

  /**
   * Mark a todo as completed.
   */
  complete(sessionId: string, id: number): TodoItem | undefined {
    return this.update(sessionId, id, { completed: true });
  }

  /**
   * Delete a todo.
   */
  delete(sessionId: string, id: number): boolean {
    return this.getStore(sessionId).delete(id);
  }

  /**
   * Clear all todos for a session.
   */
  clear(sessionId: string): void {
    this.stores.delete(sessionId);
    this.counters.delete(sessionId);
  }
}

/**
 * Singleton instance.
 */
export const TodoListService = new TodoListServiceImpl();
