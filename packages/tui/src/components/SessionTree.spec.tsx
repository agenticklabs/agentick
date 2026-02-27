import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import type { StreamEvent } from "@agentick/shared";
import { flush } from "../testing.js";

// ── Mock useEvents ──────────────────────────────────────────────────────
// Module-scoped buffer. Tests push events before render/rerender.
// The mock's useEffect (no deps = every render) drains the buffer into
// React state, which triggers useSessionTree's useEffect([events]).

let eventBuffer: StreamEvent[] = [];

vi.mock("@agentick/react", () => ({
  useEvents: () => {
    const react = require("react");
    const [events, setEvents] = react.useState<StreamEvent[]>([]);

    react.useEffect(() => {
      if (eventBuffer.length > 0) {
        setEvents(eventBuffer.splice(0));
      }
    });

    return { events };
  },
}));

function pushEvents(...events: StreamEvent[]) {
  eventBuffer.push(...events);
}

/** Push events and trigger a rerender cycle to process them */
async function sendEvents(rerender: (node: React.ReactElement) => void, ...events: StreamEvent[]) {
  pushEvents(...events);
  rerender(<SessionTree sessionId="s1" />);
  await flush();
}

beforeEach(() => {
  eventBuffer = [];
});

// Dynamic import so the mock is registered before the module loads.
const { SessionTree } = await import("./SessionTree.js");

// ── Event Factories ─────────────────────────────────────────────────────

let seq = 0;

beforeEach(() => {
  seq = 0;
});

function baseEvent() {
  return {
    id: `e-${++seq}`,
    sequence: seq,
    tick: 1,
    timestamp: new Date().toISOString(),
  };
}

function spawnStart(spawnId: string, label: string): StreamEvent {
  return {
    ...baseEvent(),
    type: "spawn_start",
    spawnId,
    parentExecutionId: "root",
    childExecutionId: `child-${spawnId}`,
    label,
  } as StreamEvent;
}

function spawnEnd(spawnId: string, opts?: { isError?: boolean }): StreamEvent {
  return {
    ...baseEvent(),
    type: "spawn_end",
    spawnId,
    parentExecutionId: "root",
    childExecutionId: `child-${spawnId}`,
    output: null,
    isError: opts?.isError,
  } as StreamEvent;
}

function toolCallStart(name: string, callId: string, spawnPath?: string[]): StreamEvent {
  return {
    ...baseEvent(),
    type: "tool_call_start",
    callId,
    name,
    blockIndex: 0,
    spawnPath,
  } as StreamEvent;
}

function toolCall(
  name: string,
  callId: string,
  summary?: string,
  spawnPath?: string[],
): StreamEvent {
  return {
    ...baseEvent(),
    type: "tool_call",
    callId,
    name,
    blockIndex: 0,
    input: {},
    summary,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    spawnPath,
  } as StreamEvent;
}

function toolResult(name: string, callId: string, spawnPath?: string[]): StreamEvent {
  return {
    ...baseEvent(),
    type: "tool_result",
    callId,
    name,
    result: "ok",
    isError: false,
    executedBy: "agent",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    spawnPath,
  } as StreamEvent;
}

// ── Core Behavior ───────────────────────────────────────────────────────

describe("SessionTree", () => {
  it("renders nothing when no spawns exist", async () => {
    const { lastFrame } = render(<SessionTree sessionId="s1" />);
    await flush();
    expect(lastFrame() ?? "").toBe("");
  });

  it("shows running spawn with spinner and label", async () => {
    pushEvents(spawnStart("sp-1", "Write tests"));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Write tests");
    expect(frame).toContain("Running 1 agent...");
  });

  it("shows tool activity on a spawn via summary", async () => {
    pushEvents(
      spawnStart("sp-1", "Refactor module"),
      toolCall("read_file", "tc-1", "Reading utils.ts", ["sp-1"]),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Refactor module");
    expect(frame).toContain("Reading utils.ts");
  });

  it("shows tool name when no summary", async () => {
    pushEvents(spawnStart("sp-1", "Agent"), toolCallStart("read_file", "tc-1", ["sp-1"]));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    expect(lastFrame()!).toContain("read_file");
  });

  it("increments tool count on tool_result", async () => {
    pushEvents(
      spawnStart("sp-1", "Agent"),
      toolResult("read_file", "tc-1", ["sp-1"]),
      toolResult("write_file", "tc-2", ["sp-1"]),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    expect(lastFrame()!).toContain("2 tools");
  });

  it("shows singular 'tool' for count of 1", async () => {
    pushEvents(spawnStart("sp-1", "Agent"), toolResult("read_file", "tc-1", ["sp-1"]));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("1 tool");
    expect(frame).not.toContain("1 tools");
  });

  it("shows done status with checkmark when spawn ends", async () => {
    pushEvents(spawnStart("sp-1", "Write tests"), spawnEnd("sp-1"));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("✓");
    expect(frame).toContain("Write tests");
    expect(frame).not.toContain("Running");
  });

  it("shows error status when spawn errors", async () => {
    pushEvents(spawnStart("sp-1", "Failing agent"), spawnEnd("sp-1", { isError: true }));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("✗");
    expect(frame).toContain("Failing agent");
  });

  it("renders tree connectors with multiple spawns", async () => {
    pushEvents(spawnStart("sp-1", "Write tests"), spawnStart("sp-2", "Refactor module"));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("├─");
    expect(frame).toContain("└─");
    expect(frame).toContain("Running 2 agents...");
  });

  it("deduplicates spawn_start events for same spawnId", async () => {
    pushEvents(spawnStart("sp-1", "Agent"), spawnStart("sp-1", "Agent dupe"));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("└─");
    expect(frame).not.toContain("├─");
    expect(frame).toContain("Agent");
    expect(frame).not.toContain("Agent dupe");
  });

  // ── Cleanup (fake timers) ─────────────────────────────────────────────

  describe("cleanup timer", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("clears tree 3s after all spawns complete", async () => {
      pushEvents(spawnStart("sp-1", "Agent"), spawnEnd("sp-1"));
      const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
      await flush();
      rerender(<SessionTree sessionId="s1" />);
      await flush();

      expect(lastFrame()!).toContain("✓");

      vi.advanceTimersByTime(3100);
      await flush();
      rerender(<SessionTree sessionId="s1" />);
      await flush();

      expect(lastFrame() ?? "").toBe("");
    });

    it("cancels cleanup timer if new spawn starts before timeout", async () => {
      pushEvents(spawnStart("sp-1", "First"), spawnEnd("sp-1"));
      const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
      await flush();
      rerender(<SessionTree sessionId="s1" />);
      await flush();
      expect(lastFrame()!).toContain("✓");

      // 2s in, new spawn starts (before 3s cleanup fires)
      vi.advanceTimersByTime(2000);
      await flush();
      await sendEvents(rerender, spawnStart("sp-2", "Second"));

      expect(lastFrame()!).toContain("Second");
    });

    it("rapid spawn cycling — old spawns cleared, new ones show", async () => {
      // Round 1: spawn and complete
      pushEvents(spawnStart("sp-1", "Round 1"), spawnEnd("sp-1"));
      const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
      await flush();
      rerender(<SessionTree sessionId="s1" />);
      await flush();
      expect(lastFrame()!).toContain("Round 1");

      // Wait for cleanup
      vi.advanceTimersByTime(3100);
      await flush();
      rerender(<SessionTree sessionId="s1" />);
      await flush();
      expect(lastFrame() ?? "").toBe("");

      // Round 2: new spawn
      await sendEvents(rerender, spawnStart("sp-2", "Round 2"));

      const frame = lastFrame()!;
      expect(frame).toContain("Round 2");
      expect(frame).not.toContain("Round 1");
    });
  });

  // ── Adversarial ───────────────────────────────────────────────────────

  it("ignores tool events for unknown spawn IDs", async () => {
    pushEvents(
      spawnStart("sp-1", "Known"),
      toolCall("read_file", "tc-1", "Surprise!", ["sp-unknown"]),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Known");
    expect(frame).not.toContain("Surprise!");
  });

  it("handles spawn_end for unknown spawn (no crash)", async () => {
    pushEvents(spawnEnd("sp-never-started"));
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    expect(lastFrame() ?? "").toBe("");
  });

  it("clears currentTool by callId, not by name (parallel same-name tools)", async () => {
    pushEvents(
      spawnStart("sp-1", "Agent"),
      // Two read_file calls with different callIds
      toolCallStart("read_file", "tc-1", ["sp-1"]),
      toolCallStart("read_file", "tc-2", ["sp-1"]),
      // tc-2 is now currentTool (last started)
      // Result for tc-1 arrives — should NOT clear currentTool
      toolResult("read_file", "tc-1", ["sp-1"]),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    // currentTool (tc-2) should still be showing
    expect(frame).toContain("read_file");
    // Tool count should be 1 (one result received)
    expect(frame).toContain("1 tool");
  });

  it("tool_call updates summary on existing currentTool", async () => {
    pushEvents(
      spawnStart("sp-1", "Agent"),
      toolCallStart("read_file", "tc-1", ["sp-1"]),
      toolCall("read_file", "tc-1", "Reading config.json", ["sp-1"]),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    expect(lastFrame()!).toContain("Reading config.json");
  });

  it("spawn_end clears currentTool even if tool_result never arrived", async () => {
    pushEvents(
      spawnStart("sp-1", "Agent"),
      toolCallStart("read_file", "tc-1", ["sp-1"]),
      spawnEnd("sp-1"),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("✓");
    // Leaf line with tool should not be shown for completed spawns
    expect(frame).not.toContain("└─ read_file");
  });

  it("root session tool events don't leak into spawn display", async () => {
    pushEvents(
      spawnStart("sp-1", "Worker"),
      // Root session tool (no spawnPath)
      toolCall("think", "tc-root", "Planning..."),
    );
    const { lastFrame, rerender } = render(<SessionTree sessionId="s1" />);
    await flush();
    rerender(<SessionTree sessionId="s1" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Worker");
    expect(frame).not.toContain("Planning...");
    expect(frame).not.toContain("think");
  });
});
