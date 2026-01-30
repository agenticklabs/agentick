/**
 * Tentickle App Setup
 *
 * Creates the app with model configuration and agent component.
 */

import { createApp } from "@tentickle/core/app";
import { TaskAssistantAgent } from "./agents/index.js";

/**
 * Create the Tentickle app instance.
 */
export function createTentickleApp() {
  return createApp(TaskAssistantAgent, {
    maxTicks: 10,
    devTools: true,
  });
}
