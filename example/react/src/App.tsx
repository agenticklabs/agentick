/**
 * Task Assistant App
 *
 * Main application component with TentickleProvider and layout.
 */

import { TentickleProvider } from "@tentickle/react";
// import { createSharedTransport } from "@tentickle/client-multiplexer";
import { ChatInterface } from "./components/ChatInterface";
import { TodoListUI } from "./components/TodoListUI";

// Create shared transport for multi-tab multiplexing
// Only one tab holds the SSE connection, others communicate via BroadcastChannel
// const sharedTransport = createSharedTransport({ baseUrl: "/api" });

export function App() {
  return (
    // <TentickleProvider clientConfig={{ baseUrl: "/api", transport: sharedTransport }}>
    <TentickleProvider clientConfig={{ baseUrl: "/api" }}>
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
