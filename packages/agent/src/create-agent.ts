/**
 * createAgent — Level 0 entry point (no JSX required).
 *
 * Generates a component wrapping <Agent> and passes it to createApp.
 * Returns the same App interface as createApp.
 *
 * For programmatic control (hooks, conditional rendering, composition),
 * write a component with <Agent> and use createApp() instead.
 */

import React from "react";
import { Agent, type AgentProps } from "./agent";
import { createApp } from "@agentick/core";
import type { AppOptions, App, ComponentFunction } from "@agentick/core";

// ============================================================================
// AgentConfig — config-only subset of AgentProps for Level 0
// ============================================================================

/**
 * Configuration for creating an agent without writing JSX (Level 0).
 *
 * Accepts all AgentProps except `children` (use createApp + <Agent> for that).
 * Pass to createAgent() to get a working App without writing components.
 */
export type AgentConfig = Omit<AgentProps, "children">;

// ============================================================================
// createAgent
// ============================================================================

export function createAgent(config: AgentConfig, options: AppOptions = {}): App {
  const ConfigAgent = () => React.createElement(Agent, config);
  ConfigAgent.displayName = "ConfigAgent";

  return createApp(ConfigAgent, options);
}

// ============================================================================
// agentComponent — for use with session.spawn()
// ============================================================================

/**
 * Convert an AgentConfig to a ComponentFunction for use with session.spawn().
 *
 * Core's spawn only accepts ComponentFunction | JSX.Element (no config objects).
 * This bridges the gap for users who want config-object spawn.
 *
 * @example
 * ```typescript
 * // In a tool handler
 * const result = await ctx.spawn(
 *   agentComponent({ system: "Research this", tools: [SearchTool] }),
 *   { messages: [...] },
 * );
 * ```
 */
export function agentComponent(config: AgentConfig): ComponentFunction {
  const SpawnedAgent = () => React.createElement(Agent, config);
  SpawnedAgent.displayName = "SpawnedAgent";
  return SpawnedAgent;
}
