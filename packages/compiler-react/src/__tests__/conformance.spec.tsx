/**
 * Wire `@agentick/spec-conformance` against `@agentick/compiler-react`.
 *
 * Compiler / DataBridge / LoopBridge conformance suites — the
 * contracts this package directly satisfies. Per ADR 27, harness
 * conformance (knobs, state, timeline) runs in each harness's own
 * package — `runKnobsHarnessConformance` lives in `@agentick/knobs`
 * and runs against the real `KnobsHarness` from
 * `@agentick/knobs/src/__tests__/harness.spec.ts` (and likewise for
 * state and timeline).
 *
 * Every suite here represents an executable contract from the
 * pluggability charter.
 */

import { describe } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  runDataBridgeConformance,
  runLoopBridgeConformance,
  runCompilerConformance,
  type ElementInput,
  type CompilerConformanceFactory,
} from "@agentick/spec-conformance";
import type { HookBridges, CompilerProtocol } from "@agentick/spec";
import { InMemoryDataBridge } from "@agentick/compiler";
import { fakeBridges, stubLoopBridge } from "@agentick/compiler";
import { CompilerHarness } from "../harness/compiler-harness.js";

// ============================================================================
// Bridge conformance
// ============================================================================

describe("InMemoryDataBridge — conformance", () => {
  runDataBridgeConformance(() => new InMemoryDataBridge());
});

describe("stubLoopBridge — conformance", () => {
  runLoopBridgeConformance(() => stubLoopBridge());
});

// ============================================================================
// Compiler conformance
// ============================================================================

let compilerCounter = 0;

const compilerFactory: CompilerConformanceFactory = {
  async createCompiler(): Promise<CompilerProtocol> {
    const scopeId = `conf-${compilerCounter++}`;
    const harness = new CompilerHarness(
      scopeId,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    return harness;
  },

  createBridges(opts?: { sessionId?: string; knobs?: Record<string, unknown> }): HookBridges {
    // The conformance suite passes a generic Record<string, unknown> for
    // knobs; fakeBridges expects Record<string, KnobPrimitive>. Cast
    // through unknown — runtime values are primitive in practice.
    return fakeBridges(opts as unknown as Parameters<typeof fakeBridges>[0]);
  },

  buildElement(input: ElementInput): unknown {
    return toReactElement(input);
  },
};

describe("CompilerHarness — conformance", () => {
  runCompilerConformance(compilerFactory);
});

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
