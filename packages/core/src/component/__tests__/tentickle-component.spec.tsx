/**
 * TentickleComponent Tests
 *
 * Tests for class-based components that extend TentickleComponent.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { TentickleComponent, createClassComponent } from "../tentickle-component";
import { createApp } from "../../app";
import { createTestAdapter } from "../../testing/test-adapter";
import { Section, Model } from "../../jsx/components/primitives";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(response = "Mock response") {
  return createTestAdapter({ defaultResponse: response });
}

// ============================================================================
// Tests
// ============================================================================

describe("TentickleComponent", () => {
  describe("basic rendering", () => {
    it("should render a simple class component", async () => {
      class SimpleAgent extends TentickleComponent {
        render() {
          return (
            <Section id="system" audience="model">
              Hello from class component
            </Section>
          );
        }
      }

      const SimpleAgentComponent = createClassComponent(SimpleAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <SimpleAgentComponent />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      // If we get here without errors, the component rendered successfully
      expect(true).toBe(true);
    });

    it("should have access to COM via this.com", async () => {
      let comAvailable = false;

      class ComAccessAgent extends TentickleComponent {
        render() {
          // Check if com is accessible
          comAvailable = !!this.com;
          return (
            <Section id="system" audience="model">
              Testing COM access
            </Section>
          );
        }
      }

      const ComAccessAgentComponent = createClassComponent(ComAccessAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <ComAccessAgentComponent />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      expect(comAvailable).toBe(true);
    });

    it("should have access to tickState via this.tickState", async () => {
      let tickNumber = -1;

      class TickStateAccessAgent extends TentickleComponent {
        render() {
          tickNumber = this.tick;
          return (
            <Section id="system" audience="model">
              Tick: {this.tick}
            </Section>
          );
        }
      }

      const TickStateAccessAgentComponent = createClassComponent(TickStateAccessAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <TickStateAccessAgentComponent />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      expect(tickNumber).toBeGreaterThanOrEqual(1);
    });
  });

  describe("lifecycle methods", () => {
    it("should call onMount when component is first rendered", async () => {
      const onMountSpy = vi.fn();

      class LifecycleAgent extends TentickleComponent {
        onMount() {
          onMountSpy();
        }

        render() {
          return (
            <Section id="system" audience="model">
              Testing lifecycle
            </Section>
          );
        }
      }

      const LifecycleAgentComponent = createClassComponent(LifecycleAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <LifecycleAgentComponent />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      expect(onMountSpy).toHaveBeenCalled();
    });

    it("should call onTickStart at the beginning of each tick", async () => {
      const onTickStartSpy = vi.fn();

      class TickStartAgent extends TentickleComponent {
        onTickStart() {
          onTickStartSpy();
        }

        render() {
          return (
            <Section id="system" audience="model">
              Testing tick start
            </Section>
          );
        }
      }

      const TickStartAgentComponent = createClassComponent(TickStartAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <TickStartAgentComponent />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      expect(onTickStartSpy).toHaveBeenCalled();
    });
  });

  describe("props handling", () => {
    it("should receive props from parent", async () => {
      interface AgentProps {
        greeting: string;
      }

      let receivedGreeting = "";

      class PropsAgent extends TentickleComponent<AgentProps> {
        render() {
          receivedGreeting = this.props.greeting;
          return (
            <Section id="system" audience="model">
              {this.props.greeting}
            </Section>
          );
        }
      }

      const PropsAgentComponent = createClassComponent(PropsAgent);
      const mockModel = createMockModel();

      function Agent() {
        return (
          <>
            <PropsAgentComponent greeting="Hello, World!" />
            <Model model={mockModel} />
          </>
        );
      }

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.tick({}).result;
      session.close();

      expect(receivedGreeting).toBe("Hello, World!");
    });
  });
});
