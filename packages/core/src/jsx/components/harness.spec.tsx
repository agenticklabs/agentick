/**
 * Tests for the Harness component.
 *
 * @module agentick/components/harness.spec
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { Harness, HarnessComponent, getHarnessContext } from "./harness.js";
import { System } from "./messages.js";
import { Timeline } from "./timeline.js";

describe("Harness Component", () => {
  describe("Harness function", () => {
    it("should create a HarnessComponent element", () => {
      const TestAgent = ({ query }: { query: string }) => (
        <>
          <System>Query: {query}</System>
          <Timeline />
        </>
      );

      // Use React.createElement to create element without executing component
      const element = React.createElement(Harness, {
        name: "test-harness",
        component: TestAgent,
        props: { query: "test" },
      });

      expect(element).toBeDefined();
      expect(element.type).toBe(HarnessComponent);
      expect(element.props.name).toBe("test-harness");
    });

    it("should pass component and props correctly", () => {
      const TestAgent = ({ message }: { message: string }) => <System>{message}</System>;

      const testProps = { message: "Hello World" };

      const element = React.createElement(Harness, {
        name: "props-test",
        component: TestAgent,
        props: testProps,
      });

      expect(element.props.component).toBe(TestAgent);
      expect(element.props.props).toBe(testProps);
    });

    it("should accept onResult callback", () => {
      const TestAgent = () => <System>Test</System>;
      const onResult = vi.fn();

      const element = React.createElement(Harness, {
        name: "callback-test",
        component: TestAgent,
        props: {},
        onResult,
      });

      expect(element.props.onResult).toBe(onResult);
    });

    it("should accept onError callback", () => {
      const TestAgent = () => <System>Test</System>;
      const onError = vi.fn();

      const element = React.createElement(Harness, {
        name: "error-test",
        component: TestAgent,
        props: {},
        onError,
      });

      expect(element.props.onError).toBe(onError);
    });

    it("should accept waitUntilComplete option", () => {
      const TestAgent = () => <System>Test</System>;

      const element = React.createElement(Harness, {
        name: "wait-test",
        component: TestAgent,
        props: {},
        waitUntilComplete: true,
      });

      expect(element.props.waitUntilComplete).toBe(true);
    });

    it("should accept maxTicks option", () => {
      const TestAgent = () => <System>Test</System>;

      const element = React.createElement(Harness, {
        name: "ticks-test",
        component: TestAgent,
        props: {},
        maxTicks: 5,
      });

      expect(element.props.maxTicks).toBe(5);
    });
  });

  describe("HarnessContext", () => {
    it("should return undefined when not in harness", () => {
      // getHarnessContext requires a COM instance
      // When not inside a harness, it should return undefined
      const mockCom = {} as any;
      const context = getHarnessContext(mockCom);
      expect(context).toBeUndefined();
    });
  });

  describe("HarnessProps types", () => {
    it("should support generic props type", () => {
      interface MyAgentProps {
        query: string;
        context?: string;
        limit?: number;
      }

      const MyAgent = ({ query, context, limit }: MyAgentProps) => (
        <System>
          Query: {query}, Context: {context}, Limit: {limit}
        </System>
      );

      const element = React.createElement(Harness<MyAgentProps>, {
        name: "typed-harness",
        component: MyAgent,
        props: {
          query: "test query",
          context: "additional context",
          limit: 10,
        },
      });

      expect(element.props.props.query).toBe("test query");
      expect(element.props.props.context).toBe("additional context");
      expect(element.props.props.limit).toBe(10);
    });
  });
});
