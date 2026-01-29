/**
 * TodoList UI Component
 *
 * Displays and manages todo items.
 * Syncs with agent via channel events.
 */

import { useState } from "react";
import { useTodoList } from "../hooks/useTodoList";

export function TodoListUI() {
  const { todos, loading, error, createTodo, toggleTodo, deleteTodo } = useTodoList();
  const [newTitle, setNewTitle] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;

    await createTodo(trimmed);
    setNewTitle("");
  };

  return (
    <>
      <div className="todo-header">
        <h2>Tasks</h2>
      </div>

      <div className="todo-list">
        {loading ? (
          <div className="todo-empty">Loading...</div>
        ) : error ? (
          <div className="todo-empty" style={{ color: "var(--danger)" }}>
            Error: {error}
          </div>
        ) : todos.length === 0 ? (
          <div className="todo-empty">
            <p>No tasks yet.</p>
            <p style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>
              Add one below or ask the assistant!
            </p>
          </div>
        ) : (
          todos.map((todo) => (
            <div key={todo.id} className="todo-item">
              <input
                type="checkbox"
                className="todo-checkbox"
                checked={todo.completed}
                onChange={(e) => toggleTodo(todo.id, e.target.checked)}
              />
              <span className={`todo-title ${todo.completed ? "completed" : ""}`}>
                {todo.title}
              </span>
              <button
                className="todo-delete"
                onClick={() => deleteTodo(todo.id)}
                title="Delete task"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div className="todo-create">
        <form className="todo-create-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="todo-create-input"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a task..."
          />
          <button type="submit" className="todo-create-btn" disabled={!newTitle.trim()}>
            Add
          </button>
        </form>
      </div>
    </>
  );
}
