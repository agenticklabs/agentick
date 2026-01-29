/**
 * Timeline Hydration Tests
 *
 * Tests for loading existing conversation history into sessions and components.
 * Covers:
 * - SessionOptions.initialTimeline
 * - com.injectHistory()
 * - useInjectHistory() hook
 * - injectHistory() standalone function
 * - Timeline component with hydrated history
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../../app";
import { createModel, type ModelInput, type ModelOutput } from "../../model/model";
import { fromEngineState, toEngineState } from "../../model/utils/language-model";
import { System, User, Assistant } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { COM } from "../../com/object-model";
import type { COMTimelineEntry } from "../../com/types";
import type { TimelineEntry, StopReason, StreamEvent } from "@tentickle/shared";
import { BlockType } from "@tentickle/shared";
import {
  useConversationHistory,
  useInjectHistory,
  injectHistory,
  useCom,
  useTickState,
  setRenderContext,
  useRef,
} from "../hooks";
import { createFiber } from "../../compiler/fiber";
import type { RenderContext } from "../../compiler/types";
import type { TickState } from "../../component/component";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockModel(response?: Partial<ModelOutput>) {
  return createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
    metadata: {
      id: "mock-model",
      provider: "mock",
      capabilities: [],
    },
    executors: {
      execute: async (_input: ModelInput) =>
        ({
          model: "mock-model",
          createdAt: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Mock response" }],
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "stop" as StopReason,
          raw: {},
          ...response,
        }) as ModelOutput,
      executeStream: async function* (_input: ModelInput) {
        yield {
          type: "content_delta",
          blockType: BlockType.TEXT,
          blockIndex: 0,
          delta: "Mock",
        } as StreamEvent;
      },
    },
    transformers: {
      processStream: async (chunks: StreamEvent[]) => {
        let text = "";
        for (const chunk of chunks) {
          if (chunk.type === "content_delta") text += chunk.delta;
        }
        return {
          model: "mock-model",
          createdAt: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "stop" as StopReason,
          raw: {},
        } as ModelOutput;
      },
    },
    fromEngineState,
    toEngineState,
  });
}

function createTimelineEntry(role: "user" | "assistant", text: string): TimelineEntry {
  return {
    kind: "message",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

function createCOMTimelineEntry(role: "user" | "assistant", text: string): COMTimelineEntry {
  return {
    kind: "message",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

// ============================================================================
// COM.injectHistory() Tests
// ============================================================================

describe("COM.injectHistory()", () => {
  let com: COM;

  beforeEach(() => {
    com = new COM();
  });

  it("should inject entries at the beginning of timeline", () => {
    const entries: COMTimelineEntry[] = [
      createCOMTimelineEntry("user", "Hello"),
      createCOMTimelineEntry("assistant", "Hi there!"),
    ];

    com.injectHistory(entries);

    const timeline = com.getTimeline();
    expect(timeline).toHaveLength(2);
    expect(timeline[0].message?.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(timeline[1].message?.content[0]).toEqual({ type: "text", text: "Hi there!" });
  });

  it("should prepend to existing timeline entries", () => {
    // Add a new message first
    com.addMessage({
      role: "user",
      content: [{ type: "text", text: "New message" }],
    });

    // Then inject history
    const entries: COMTimelineEntry[] = [
      createCOMTimelineEntry("user", "Old message 1"),
      createCOMTimelineEntry("assistant", "Old message 2"),
    ];

    com.injectHistory(entries);

    const timeline = com.getTimeline();
    expect(timeline).toHaveLength(3);
    // Injected entries come first
    expect(timeline[0].message?.content[0]).toEqual({ type: "text", text: "Old message 1" });
    expect(timeline[1].message?.content[0]).toEqual({ type: "text", text: "Old message 2" });
    // New message is last
    expect(timeline[2].message?.content[0]).toEqual({ type: "text", text: "New message" });
  });

  it("should emit timeline:modified events for each injected entry", () => {
    const listener = vi.fn();
    com.on("timeline:modified", listener);

    const entries: COMTimelineEntry[] = [
      createCOMTimelineEntry("user", "Message 1"),
      createCOMTimelineEntry("assistant", "Message 2"),
    ];

    com.injectHistory(entries);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(entries[0], "add");
    expect(listener).toHaveBeenCalledWith(entries[1], "add");
  });

  it("should handle empty entries array gracefully", () => {
    com.injectHistory([]);
    expect(com.getTimeline()).toHaveLength(0);
  });

  it("should preserve entry metadata when injecting", () => {
    const entries: COMTimelineEntry[] = [
      {
        kind: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "With metadata" }],
        },
        tags: ["important"],
        metadata: { source: "loaded" },
      },
    ];

    com.injectHistory(entries);

    const timeline = com.getTimeline();
    expect(timeline[0].tags).toEqual(["important"]);
    expect(timeline[0].metadata).toEqual({ source: "loaded" });
  });
});

// ============================================================================
// useInjectHistory() Hook Tests
// ============================================================================

describe("useInjectHistory() hook", () => {
  let com: COM;
  let tickState: TickState;
  let renderContext: RenderContext;
  let fiber: ReturnType<typeof createFiber>;

  beforeEach(() => {
    com = new COM();
    tickState = {
      tick: 1,
      stop: vi.fn(),
      queuedMessages: [],
    } as TickState;

    fiber = createFiber(() => null, {}, null);
    renderContext = {
      fiber,
      com,
      tickState,
      currentHook: null,
      workInProgressHook: null,
    };
  });

  afterEach(() => {
    setRenderContext(null);
  });

  it("should inject entries on first render", () => {
    setRenderContext(renderContext);

    const entries: COMTimelineEntry[] = [
      createCOMTimelineEntry("user", "Hello"),
      createCOMTimelineEntry("assistant", "Hi!"),
    ];

    useInjectHistory(entries);

    expect(com.getTimeline()).toHaveLength(2);
  });

  it("should only inject once (not on re-render)", () => {
    setRenderContext(renderContext);

    const entries: COMTimelineEntry[] = [createCOMTimelineEntry("user", "Hello")];

    // First render
    useInjectHistory(entries);
    expect(com.getTimeline()).toHaveLength(1);

    // Simulate re-render
    const prevHook = fiber.memoizedState;
    renderContext.currentHook = prevHook;
    renderContext.workInProgressHook = null;
    fiber.memoizedState = null;
    setRenderContext(renderContext);

    // Second render - should not inject again
    useInjectHistory(entries);
    expect(com.getTimeline()).toHaveLength(1);
  });

  it("should support function that returns entries", () => {
    setRenderContext(renderContext);

    const getEntries = () => [createCOMTimelineEntry("user", "From function")];

    useInjectHistory(getEntries);

    expect(com.getTimeline()).toHaveLength(1);
    expect(com.getTimeline()[0].message?.content[0]).toEqual({
      type: "text",
      text: "From function",
    });
  });

  it("should not inject if entries array is empty", () => {
    setRenderContext(renderContext);

    useInjectHistory([]);

    expect(com.getTimeline()).toHaveLength(0);
  });
});

// ============================================================================
// injectHistory() Standalone Function Tests
// ============================================================================

describe("injectHistory() standalone function", () => {
  it("should inject entries via COM", () => {
    const com = new COM();
    const entries: COMTimelineEntry[] = [createCOMTimelineEntry("user", "Standalone test")];

    injectHistory(com, entries);

    expect(com.getTimeline()).toHaveLength(1);
    expect(com.getTimeline()[0].message?.content[0]).toEqual({
      type: "text",
      text: "Standalone test",
    });
  });
});

// ============================================================================
// SessionOptions.initialTimeline Tests
// ============================================================================

describe("SessionOptions.initialTimeline", () => {
  it("should hydrate session with initial timeline entries", async () => {
    const mockModel = createMockModel();

    // Track what history the component sees
    let capturedHistory: COMTimelineEntry[] = [];

    const ChatAgent = () => {
      const history = useConversationHistory();
      capturedHistory = history;

      return (
        <>
          <Model model={mockModel} />
          <System>You are helpful.</System>
          {history.map((entry, i) => {
            const text = entry.message?.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (entry.message?.role === "user") {
              return <User key={i}>{text}</User>;
            }
            return <Assistant key={i}>{text}</Assistant>;
          })}
          <Assistant />
        </>
      );
    };

    const initialTimeline: TimelineEntry[] = [
      createTimelineEntry("user", "Previous question"),
      createTimelineEntry("assistant", "Previous answer"),
    ];

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession({ initialTimeline });

    await session.tick({}).result;

    // History should include the initial timeline entries
    expect(capturedHistory.length).toBeGreaterThanOrEqual(2);

    const userMessages = capturedHistory.filter((e) => e.message?.role === "user");
    const assistantMessages = capturedHistory.filter((e) => e.message?.role === "assistant");

    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    session.close();
  });

  it("should not duplicate entries on subsequent ticks", async () => {
    const mockModel = createMockModel();
    const historyCounts: number[] = [];
    let sendIndex = 0;

    const ChatAgent = () => {
      const history = useConversationHistory();

      // Track history count per send (not per tick, since each send creates new RuntimeSession)
      historyCounts[sendIndex] = history.length;

      return (
        <>
          <Model model={mockModel} />
          <System>You are helpful.</System>
          <Assistant />
        </>
      );
    };

    const initialTimeline: TimelineEntry[] = [
      createTimelineEntry("user", "Message 1"),
      createTimelineEntry("assistant", "Response 1"),
    ];

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession({ initialTimeline });

    // First send
    await session.tick({}).result;
    sendIndex++;

    // Second send
    await session.tick({}).result;

    // History should grow by model response each send, not duplicate initial
    // Send 1: 2 (initial) visible during render
    // Send 2: 3 (2 initial + 1 response from send 1) visible during render
    expect(historyCounts[0]).toBe(2); // Initial history visible on first send
    expect(historyCounts[1]).toBe(3); // Previous (2 initial + 1 response from send 1)

    session.close();
  });

  it("should work with empty initialTimeline", async () => {
    const mockModel = createMockModel();
    let capturedHistory: COMTimelineEntry[] = [];

    const ChatAgent = () => {
      capturedHistory = useConversationHistory();
      return (
        <>
          <Model model={mockModel} />
          <System>Test</System>
          <Assistant />
        </>
      );
    };

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession({ initialTimeline: [] });

    await session.tick({}).result;

    // Should only have the current tick's messages
    expect(capturedHistory.length).toBeLessThanOrEqual(1);

    session.close();
  });
});

// ============================================================================
// Timeline Component with Hydration Tests
// ============================================================================

describe("Timeline component with hydration", () => {
  it("should render hydrated history entries", async () => {
    const mockModel = createMockModel();
    let renderedEntries: COMTimelineEntry[] = [];
    let directHistory: COMTimelineEntry[] = [];

    const ChatAgent = () => {
      // Capture history directly to compare
      directHistory = useConversationHistory();

      return (
        <>
          <Model model={mockModel} />
          <System>You are helpful.</System>
          <Timeline>
            {(history, _pending) => {
              renderedEntries = history;
              return (
                <>
                  {history.map((entry, i) => {
                    const text = entry.message?.content
                      .filter((b): b is { type: "text"; text: string } => b.type === "text")
                      .map((b) => b.text)
                      .join("");
                    if (entry.message?.role === "user") {
                      return <User key={i}>{text}</User>;
                    }
                    return <Assistant key={i}>{text}</Assistant>;
                  })}
                </>
              );
            }}
          </Timeline>
        </>
      );
    };

    const initialTimeline: TimelineEntry[] = [
      createTimelineEntry("user", "Hydrated user message"),
      createTimelineEntry("assistant", "Hydrated assistant message"),
    ];

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession({ initialTimeline });

    await session.tick({}).result;

    // Direct history should have the entries (this works in other tests)
    expect(directHistory.length).toBeGreaterThanOrEqual(2);

    // Timeline render prop should receive the same hydrated entries
    expect(renderedEntries.length).toBeGreaterThanOrEqual(2);

    const hasHydratedUser = renderedEntries.some(
      (e) =>
        e.message?.role === "user" &&
        e.message?.content.some(
          (b) => b.type === "text" && (b as any).text === "Hydrated user message",
        ),
    );
    expect(hasHydratedUser).toBe(true);

    session.close();
  });

  it("should show pending messages via render prop", async () => {
    const mockModel = createMockModel();
    let capturedPending: any[] = [];

    const ChatAgent = () => {
      return (
        <>
          <Model model={mockModel} />
          <System>Test</System>
          <Timeline>
            {(_history, pending) => {
              capturedPending = pending ?? [];
              return <Assistant />;
            }}
          </Timeline>
        </>
      );
    };

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession();

    await session.tick({}).result;

    // Pending should be accessible (even if empty)
    expect(Array.isArray(capturedPending)).toBe(true);

    session.close();
  });
});

// ============================================================================
// Integration: Component-driven hydration with useInit
// ============================================================================

describe("Component-driven hydration", () => {
  it("should support hydration via com.injectHistory in component", async () => {
    const mockModel = createMockModel();
    let capturedHistory: COMTimelineEntry[] = [];

    // Simulated async data loader
    // const loadConversation = async (): Promise<COMTimelineEntry[]> => {
    //   return [
    //     createCOMTimelineEntry("user", "Async loaded user"),
    //     createCOMTimelineEntry("assistant", "Async loaded assistant"),
    //   ];
    // };

    const ChatAgent = () => {
      const com = useCom();
      const state = useTickState();
      const hasLoaded = useRef(false);

      // Inject history on tick 1 only
      if (state.tick === 1 && !hasLoaded.current) {
        // Synchronous for test simplicity - in real code use useInit
        const entries = [
          createCOMTimelineEntry("user", "Injected via component"),
          createCOMTimelineEntry("assistant", "Component injection response"),
        ];
        com.injectHistory(entries);
        hasLoaded.current = true;
      }

      capturedHistory = useConversationHistory();

      return (
        <>
          <Model model={mockModel} />
          <System>You are helpful.</System>
          <Assistant />
        </>
      );
    };

    const app = createApp(ChatAgent, { model: mockModel });
    const session = app.createSession();

    await session.tick({}).result;

    // Should have injected entries
    expect(capturedHistory.length).toBeGreaterThanOrEqual(2);

    const hasInjectedUser = capturedHistory.some(
      (e) =>
        e.message?.role === "user" &&
        e.message?.content.some(
          (b) => b.type === "text" && (b as any).text === "Injected via component",
        ),
    );
    expect(hasInjectedUser).toBe(true);

    session.close();
  });
});
