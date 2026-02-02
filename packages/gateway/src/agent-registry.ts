/**
 * Agent Registry
 *
 * Manages available agents and their configurations.
 */

import type { App } from "@tentickle/core";

export interface AgentInfo {
  id: string;
  app: App;
  name?: string;
  description?: string;
  isDefault: boolean;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();
  private defaultAgentId: string;

  constructor(agents: Record<string, App>, defaultAgent: string) {
    if (!agents[defaultAgent]) {
      throw new Error(
        `Default agent "${defaultAgent}" not found in agents: ${Object.keys(agents).join(", ")}`,
      );
    }

    this.defaultAgentId = defaultAgent;

    for (const [id, app] of Object.entries(agents)) {
      this.agents.set(id, {
        id,
        app,
        isDefault: id === defaultAgent,
      });
    }
  }

  /**
   * Get an agent by ID
   */
  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }

  /**
   * Get the default agent
   */
  getDefault(): AgentInfo {
    return this.agents.get(this.defaultAgentId)!;
  }

  /**
   * Get the default agent ID
   */
  get defaultId(): string {
    return this.defaultAgentId;
  }

  /**
   * Check if an agent exists
   */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * Get all agent IDs
   */
  ids(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get all agents
   */
  all(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent count
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Resolve an agent ID, falling back to default
   */
  resolve(id?: string): AgentInfo {
    if (!id) {
      return this.getDefault();
    }

    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Unknown agent "${id}". Available: ${this.ids().join(", ")}`);
    }

    return agent;
  }
}
