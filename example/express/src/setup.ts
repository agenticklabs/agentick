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
      // Auto-hibernate sessions after 5 minutes of inactivity
      idleTimeout: 5 * 60 * 1000,
      // Keep max 100 sessions in memory
      maxActive: 100,
    },
    // Lifecycle hooks for debugging
    onAfterHibernate: (sessionId, snapshot) => {
      console.log(`[Session] Hibernated ${sessionId} (tick ${snapshot.tick})`);
    },
    onAfterHydrate: (session, snapshot) => {
      console.log(`[Session] Hydrated ${session.id} from tick ${snapshot.tick}`);
    },
  });
}
