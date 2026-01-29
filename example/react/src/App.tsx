/**
 * Task Assistant App
 *
 * Main application component with TentickleProvider and layout.
 */

import { TentickleProvider } from "@tentickle/react";
import { ChatInterface } from "./components/ChatInterface";
import { TodoListUI } from "./components/TodoListUI";

export function App() {
  return (
    <TentickleProvider clientConfig={{ baseUrl: "http://localhost:5173/api" }}>
      <div className="app">
        <header className="app-header">
          <h1>Task Assistant</h1>
          <p>A Tentickle example app with todo management and calculations</p>
        </header>

        <main className="app-main">
          <div className="chat-panel">
            <ChatInterface />
          </div>

          <aside className="todo-panel">
            <TodoListUI />
          </aside>
        </main>

        <footer className="app-footer">
          <p>
            Powered by <a href="https://github.com/tentickle/tentickle">Tentickle</a>
          </p>
        </footer>
      </div>
    </TentickleProvider>
  );
}
