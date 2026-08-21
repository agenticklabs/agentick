import type { SendResult, StreamEvent } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { createSessionExecutionHandle } from "../session-execution-handle.js";

function handleWith(events: ReadonlyArray<{ blockIndex: number; delta: string }>) {
  const created = createSessionExecutionHandle({
    sessionId: "s1",
    executionId: "e1",
    resultPromise: Promise.resolve({} as SendResult),
    abort: () => Promise.resolve(),
  });
  for (const e of events)
    created.emit({ type: "content-delta", blockIndex: e.blockIndex, delta: e.delta });
  created.close();
  return created.handle;
}

async function drain(stream: ReadableStream<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("SessionExecutionHandle streaming bridges", () => {
  it("readable() surfaces the same events as events(), context fields stamped, in order", async () => {
    const events = await drain(
      handleWith([
        { blockIndex: 0, delta: "he" },
        { blockIndex: 0, delta: "llo" },
      ]).readable(),
    );

    expect(events.map((e) => (e as { delta: string }).delta)).toEqual(["he", "llo"]);
    expect(events.every((e) => e.sessionId === "s1" && e.executionId === "e1")).toBe(true);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("pipeTo() drains every event to a WritableStream in order, then closes it", async () => {
    const written: StreamEvent[] = [];
    let closed = false;
    const sink = new WritableStream<StreamEvent>({
      write: (chunk) => void written.push(chunk),
      close: () => void (closed = true),
    });

    await handleWith([
      { blockIndex: 0, delta: "a" },
      { blockIndex: 0, delta: "b" },
      { blockIndex: 0, delta: "c" },
    ]).pipeTo(sink);

    expect(written.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b", "c"]);
    expect(closed).toBe(true);
  });

  it("pipeTo({ preventClose }) leaves the destination open for reuse", async () => {
    let closed = false;
    const sink = new WritableStream<StreamEvent>({
      write: () => {},
      close: () => void (closed = true),
    });

    await handleWith([{ blockIndex: 0, delta: "x" }]).pipeTo(sink, { preventClose: true });
    expect(closed).toBe(false);
    await sink.close();
    expect(closed).toBe(true);
  });
});
