/**
 * @tentickle/agent — Opinionated agent composition
 *
 * High-level Agent component and createAgent factory.
 * Built on @tentickle/core primitives.
 */

export {
  Agent,
  type AgentProps,
  type AgentTokenBudgetConfig,
  type AgentTimelineConfig,
  type AgentSectionConfig,
} from "./agent";

export { createAgent, agentComponent, type AgentConfig } from "./create-agent";
