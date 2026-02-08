/**
 * Task Assistant App
 *
 * Main application component with AgentickProvider and layout.
 */

import { useState, useEffect } from "react";
import { AgentickProvider } from "@agentick/react";
import { createSharedTransport } from "@agentick/client-multiplexer";
import { ChatInterface } from "./components/ChatInterface";
import { TodoListUI } from "./components/TodoListUI";

// Create shared transport for multi-tab multiplexing
// Only one tab holds the SSE connection, others communicate via BroadcastChannel
//
// HMR Support: Store transport on window to survive hot module reloads.
// Without this, each HMR reload creates a new transport with a new elector,
// but the old elector's Web Lock callback is still running as a zombie.
declare global {
  interface Window {
    __agentickTransport?: ReturnType<typeof createSharedTransport>;
  }
}

const sharedTransport = window.__agentickTransport ?? createSharedTransport({ baseUrl: "/api" });
window.__agentickTransport = sharedTransport;

/**
 * Shows the current tab's leader/follower status for the shared connection.
 */
function LeadershipIndicator() {
  const [isLeader, setIsLeader] = useState(sharedTransport.isLeader);

  useEffect(() => {
    // Subscribe to leadership changes
    return sharedTransport.onLeadershipChange((leader) => {
      setIsLeader(leader);
    });
  }, []);

  return (
    <span
      className={`leadership-indicator ${isLeader ? "leader" : "follower"}`}
      title={
        isLeader ? "This tab holds the server connection" : "This tab uses the leader's connection"
      }
    >
      {isLeader ? "👑 Leader" : "👥 Follower"}{" "}
      <span className="tab-id">(Tab: {sharedTransport.tabId.slice(0, 8)})</span>
    </span>
  );
}

export function App() {
  return (
    <AgentickProvider clientConfig={{ baseUrl: "/api", transport: sharedTransport }}>
      <div className="app">
        <header className="app-header">
          <div className="header-row">
            <h1>Task Assistant</h1>
            <LeadershipIndicator />
          </div>
          <p>A Agentick example app with todo management and calculations</p>
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
            Powered by <a href="https://github.com/agentick/agentick">Agentick</a>
          </p>
        </footer>
      </div>
    </AgentickProvider>
  );
}
