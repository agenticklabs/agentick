/**
 * useTodoList Hook
 *
 * Manages todo list state with channel-based synchronization.
 * Demonstrates:
 * - useChannel for real-time updates from agent
 * - REST API calls for direct manipulation
 * - Optimistic updates
 */

import { useState, useEffect, useCallback } from "react";
import { useChannel } from "@tentickle/react";

export interface TodoItem {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

const TODO_CHANNEL = "todo-list";

export function useTodoList() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channel = useChannel(TODO_CHANNEL);

  // Fetch initial todos
  useEffect(() => {
    fetchTodos();
  }, []);

  // Subscribe to channel updates
  useEffect(() => {
    const unsubscribe = channel.subscribe((payload: { todos?: TodoItem[] }, event) => {
      if (event.type === "state_changed" && payload?.todos) {
        setTodos(payload.todos);
      }
    });

    return unsubscribe;
  }, [channel]);

  const fetchTodos = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/tasks?sessionId=default");
      if (!res.ok) throw new Error("Failed to fetch tasks");
      const data = await res.json();
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
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sessionId: "default" }),
      });
      if (!res.ok) throw new Error("Failed to create task");
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const toggleTodo = useCallback(async (id: number, completed: boolean) => {
    // Optimistic update
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed } : t))
    );

    try {
      setError(null);
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed, sessionId: "default" }),
      });
      if (!res.ok) throw new Error("Failed to update task");
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      // Revert optimistic update
      setTodos((prev) =>
        prev.map((t) => (t.id === id ? { ...t, completed: !completed } : t))
      );
    }
  }, []);

  const deleteTodo = useCallback(async (id: number) => {
    // Optimistic update
    const previousTodos = todos;
    setTodos((prev) => prev.filter((t) => t.id !== id));

    try {
      setError(null);
      const res = await fetch(`/api/tasks/${id}?sessionId=default`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete task");
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      // Revert optimistic update
      setTodos(previousTodos);
    }
  }, [todos]);

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
