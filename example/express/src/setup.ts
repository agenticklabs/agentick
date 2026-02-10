/**
 * Agentick App Setup
 *
 * Creates the app with model configuration and agent component.
 */

import { createApp } from "@agentick/core/app";
import { TaskAssistantAgent } from "./agents/index.js";

/**
 * Create the Agentick app instance.
 */
export function createAgentickApp() {
  return createApp(TaskAssistantAgent, {
    maxTicks: 50,
    devTools: true,
    // Session management with SQLite persistence
    sessions: {
      // SQLite file for persistent sessions (survives server restarts)
      store: "./data/sessions.db",
      // Evict sessions from memory after 5 minutes of inactivity
      idleTimeout: 5 * 60 * 1000,
      // Keep max 100 sessions in memory
      maxActive: 100,
    },
    // Lifecycle hooks for debugging
    onAfterPersist: (sessionId, snapshot) => {
      console.log(`[Session] Persisted ${sessionId} (tick ${snapshot.tick})`);
    },
    onAfterRestore: (session, snapshot) => {
      console.log(`[Session] Restored ${session.id} from tick ${snapshot.tick}`);
    },
  });
}
