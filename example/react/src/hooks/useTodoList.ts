/**
 * useTodoList Hook
 *
 * Manages todo list state with channel-based synchronization.
 * Demonstrates:
 * - Session-scoped channels for real-time updates from agent
 * - REST API calls for direct manipulation
 * - Optimistic updates
 */

import { useState, useEffect, useCallback } from "react";
import { useSession } from "@agentick/react";

export interface TodoItem {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

const TODO_CHANNEL = "todo-list";
const SESSION_ID = "default";

export function useTodoList() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Don't auto-subscribe - let the session be created by user interaction first
  const { accessor } = useSession({ sessionId: SESSION_ID });

  // Fetch initial todos
  useEffect(() => {
    fetchTodos();
  }, []);

  // Subscribe to channel updates
  useEffect(() => {
    if (!accessor) return;

    const channel = accessor.channel(TODO_CHANNEL);
    // Handler signature: (payload, event) where payload is the event's payload
    // and event is the full ChannelEvent (with type, channel, etc.)
    const unsubscribe = channel.subscribe((payload: unknown, event: { type: string }) => {
      if (event.type === "state_changed" && payload && typeof payload === "object") {
        const data = payload as { todos?: TodoItem[] };
        if (data.todos) {
          setTodos(data.todos);
        }
      }
    });

    return unsubscribe;
  }, [accessor]);

  // Helper to invoke gateway methods
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const res = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error(error.error || "Request failed");
    }
    return res.json();
  };

  const fetchTodos = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await invoke("tasks:list", { sessionId: SESSION_ID });
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const createTodo = useCallback(async (title: string) => {
    try {
      setError(null);
      const data = await invoke("tasks:create", { title, sessionId: SESSION_ID });
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const toggleTodo = useCallback(async (id: number, completed: boolean) => {
    // Optimistic update
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed } : t)));

    try {
      setError(null);
      const data = await invoke("tasks:update", { id, completed, sessionId: SESSION_ID });
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      // Revert optimistic update
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !completed } : t)));
    }
  }, []);

  const deleteTodo = useCallback(
    async (id: number) => {
      // Optimistic update
      const previousTodos = todos;
      setTodos((prev) => prev.filter((t) => t.id !== id));

      try {
        setError(null);
        const data = await invoke("tasks:delete", { id, sessionId: SESSION_ID });
        setTodos(data.todos || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Revert optimistic update
        setTodos(previousTodos);
      }
    },
    [todos],
  );

  return {
    todos,
    loading,
    error,
    createTodo,
    toggleTodo,
    deleteTodo,
    refresh: fetchTodos,
  };
}
