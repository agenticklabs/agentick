/**
 * Wire `@agentick/spec-conformance` against the reference impls in
 * `@agentick/reconciler-react`.
 *
 * Every suite here represents an executable contract from the
 * pluggability charter. Any future implementation that satisfies the
 * same protocols passes the same suites.
 */

import { describe } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  runDataBridgeConformance,
  runKnobBridgeConformance,
  runLoopBridgeConformance,
  runReconcilerConformance,
  runTimelineBridgeConformance,
  type ElementInput,
  type ReconcilerConformanceFactory,
} from "@agentick/spec-conformance";
import type { HookBridges, ReconcilerProtocol } from "@agentick/spec";
import { InMemoryDataBridge } from "../bridges/in-memory-data-bridge.js";
import {
  inMemoryKnobBridge,
  stubBridges,
  stubLoopBridge,
  stubTimelineBridge,
} from "../bridges/stub-bridges.js";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";

// ============================================================================
// Bridge conformance
// ============================================================================

describe("InMemoryDataBridge — conformance", () =>
  runDataBridgeConformance(() => new InMemoryDataBridge()));

describe("inMemoryKnobBridge — conformance", () =>
  runKnobBridgeConformance(() => inMemoryKnobBridge()));

describe("stubTimelineBridge — conformance", () =>
  runTimelineBridgeConformance(() => stubTimelineBridge()));

describe("stubLoopBridge — conformance", () => runLoopBridgeConformance(() => stubLoopBridge()));

// ============================================================================
// Reconciler conformance
// ============================================================================

let reconcilerCounter = 0;

const reconcilerFactory: ReconcilerConformanceFactory = {
  async createReconciler(): Promise<ReconcilerProtocol> {
    const scopeId = `conf-${reconcilerCounter++}`;
    const harness = new ReconcilerHarness(
      scopeId,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    return harness;
  },

  createBridges(opts?: { sessionId?: string; knobs?: Record<string, unknown> }): HookBridges {
    return stubBridges(opts);
  },

  buildElement(input: ElementInput): unknown {
    return toReactElement(input);
  },
};

describe("ReconcilerHarness — conformance", () => runReconcilerConformance(reconcilerFactory));

// ============================================================================
// helpers
// ============================================================================

function toReactElement(input: ElementInput): React.ReactNode {
  switch (input.kind) {
    case "fragment":
      return React.createElement(
        React.Fragment,
        null,
        ...(input.children ?? []).map((c, i) =>
          React.createElement(
            React.Fragment,
            { key: `c${i}` },
            toReactElement(c) as React.ReactNode,
          ),
        ),
      );
    case "section":
      return React.createElement(
        "section",
        {
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
        input.text ?? "",
      );
    case "message":
      return React.createElement("message", { role: input.role }, input.text ?? "");
    case "tool":
      return React.createElement("tool", {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        inputSchema: { type: "object" },
        ...(input.handlerRef !== undefined ? { handlerRef: input.handlerRef } : {}),
      });
  }
}
