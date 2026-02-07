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
import { Agent } from "./jsx/components/agent";
import { createApp } from "./tentickle-instance";
import type { AppOptions, App } from "./app/types";
import type { ToolClass } from "./tool/tool";
import type { EngineModel } from "./model/model";
import type { KnobDescriptor } from "./hooks/knob";

// ============================================================================
// AgentConfig — lives here alongside createAgent
// ============================================================================

/**
 * Configuration for creating an agent without writing JSX (Level 0).
 *
 * Pass to createAgent() to get a working App without writing components.
 * For programmatic control (conditional tools, hard knobs, custom
 * continuation), write a component with <Agent> instead (Level 1+).
 */
export interface AgentConfig {
  /** System prompt. Rendered as a model-visible section. */
  system?: string;
  /** Model adapter. */
  model?: EngineModel;
  /** Tools (ToolClass values from createTool). */
  tools?: ToolClass[];
  /** Knobs — model-visible, model-settable parameters. */
  knobs?: Record<string, KnobDescriptor<any, any>>;
}

// ============================================================================
// createAgent
// ============================================================================

export function createAgent(config: AgentConfig, options: AppOptions = {}): App {
  const ConfigAgent = () =>
    React.createElement(Agent, {
      system: config.system,
      model: config.model,
      tools: config.tools,
      knobs: config.knobs,
    });
  ConfigAgent.displayName = "ConfigAgent";

  return createApp(ConfigAgent, options);
}
