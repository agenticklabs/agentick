/**
 * `progressView` — classification and defense.
 *
 * The fold's two jobs are pinned separately. `foldProgress` is the whole
 * semantic (classification from a single frame, and the guards against an
 * emitter that violates the laws), so most cases drive it directly. The
 * subscription case pins that `progressView` wires the same fold to the
 * cross-surface progress query and exposes it as an ordinary view.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProgressEventPayload,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec";
import { progressEventName } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { foldProgress, progressView, type ProgressStates } from "../progress-view.js";

const scope: SubscriptionScope = { kind: "session", id: "s1" };
const empty: ProgressStates = new Map();

/** Fold a run of frames, starting empty. */
function fold(...frames: ProgressEventPayload[]): ProgressStates {
  return frames.reduce<ProgressStates>(foldProgress, empty);
}

describe("foldProgress — classification from a single frame (the late-join guarantee)", () => {
  it("classifies a determinate frame with no prior state", () => {
    // A client that connected mid-flight sees THIS frame first and still renders a bar.
    expect(fold({ token: "t", progress: 30, total: 60, message: "halfway" }).get("t")).toEqual({
      kind: "determinate",
      fraction: 0.5,
      progress: 30,
      total: 60,
      message: "halfway",
    });
  });

  it("classifies an indeterminate frame with no prior state", () => {
    expect(fold({ token: "t", progress: 7 }).get("t")).toEqual({
      kind: "indeterminate",
      progress: 7,
    });
  });

  it("keeps tokens independent", () => {
    const states = fold({ token: "a", progress: 1, total: 2 }, { token: 42, progress: 9 });
    expect(states.get("a")?.kind).toBe("determinate");
    expect(states.get(42)?.kind).toBe("indeterminate");
    expect(states.size).toBe(2);
  });

  it("is latest-frame-wins per token", () => {
    const states = fold(
      { token: "t", progress: 1, total: 10, message: "first" },
      { token: "t", progress: 4, total: 10 },
    );
    expect(states.get("t")).toEqual({
      kind: "determinate",
      fraction: 0.4,
      progress: 4,
      total: 10,
    });
  });
});

describe("foldProgress — fraction", () => {
  it("clamps to [0, 1] when an emitter overshoots its own total", () => {
    const s = fold({ token: "t", progress: 99, total: 10 });
    expect(s.get("t")).toMatchObject({ fraction: 1, progress: 99, total: 10 });
  });

  it("is 0 at the opening frame", () => {
    expect(fold({ token: "t", progress: 0, total: 4 })).toMatchObject(
      new Map([["t", { fraction: 0 }]]),
    );
  });
});

describe("foldProgress — the ratchet upgrade is honored", () => {
  it("a total appearing mid-stream turns a spinner into a bar", () => {
    const states = fold(
      { token: "t", progress: 3 },
      { token: "t", progress: 3, total: 12, message: "content-length known" },
    );
    expect(states.get("t")).toEqual({
      kind: "determinate",
      fraction: 0.25,
      progress: 3,
      total: 12,
      message: "content-length known",
    });
  });
});

describe("foldProgress — defense against emitters we do not control", () => {
  it("drops a frame that goes backwards", () => {
    const states = fold(
      { token: "t", progress: 8, total: 10 },
      { token: "t", progress: 2, total: 10 },
    );
    expect(states.get("t")).toMatchObject({ progress: 8 });
  });

  it("drops a frame that shrinks an established total", () => {
    const states = fold(
      { token: "t", progress: 5, total: 10 },
      { token: "t", progress: 6, total: 6 },
    );
    expect(states.get("t")).toMatchObject({ progress: 5, total: 10 });
  });

  it("drops a frame that grows an established total (law 2 — never changes, either way)", () => {
    const states = fold(
      { token: "t", progress: 5, total: 10 },
      { token: "t", progress: 6, total: 99 },
    );
    expect(states.get("t")).toMatchObject({ progress: 5, total: 10 });
  });

  it("drops a frame that removes an established total (no silent downgrade to a spinner)", () => {
    const states = fold({ token: "t", progress: 5, total: 10 }, { token: "t", progress: 6 });
    expect(states.get("t")).toMatchObject({ kind: "determinate", progress: 5, total: 10 });
  });

  it("drops malformed frames outright, leaving prior state intact", () => {
    const base = fold({ token: "t", progress: 5, total: 10 });
    const bad: ProgressEventPayload[] = [
      { token: "t", progress: Number.NaN, total: 10 },
      { token: "t", progress: -1, total: 10 },
      { token: "t", progress: 6, total: 0 },
      { token: "t", progress: 6, total: Number.POSITIVE_INFINITY },
      { progress: 6 } as unknown as ProgressEventPayload, // no token
    ];
    for (const frame of bad) {
      expect(foldProgress(base, frame)).toBe(base); // unchanged, identity preserved
    }
  });
});

// ── The view wiring ──────────────────────────────────────────────────────────

function pushStream(): SubscriptionStream & { emit(p: unknown): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  let closed = false;
  const stream = {
    subscriptionId: "sub-progress",
    emit(payload: unknown): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "tool",
          name: progressEventName("tool"),
          phase: "terminal",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      let w: ((r: IteratorResult<EventFrame>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
  };
  return stream as SubscriptionStream & { emit(p: unknown): void };
}

describe("progressView — the subscription", () => {
  it("subscribes with the cross-surface progress query and folds live frames", async () => {
    const stream = pushStream();
    let captured: EventQuery | undefined;
    const client = {
      transport: {
        subscribe(_scope: SubscriptionScope, query?: EventQuery): SubscriptionStream {
          captured = query;
          return stream;
        },
      },
    };

    const view = progressView(client as never, scope);
    expect(captured).toEqual({ name: { wildcard: "*:signal:progress" } });
    expect(view.get().size).toBe(0);

    stream.emit({ token: "tc:1", progress: 1, total: 4 });
    await waitFor(() => view.get().size > 0);
    expect(view.get().get("tc:1")).toMatchObject({ kind: "determinate", fraction: 0.25 });

    stream.emit({ token: "tc:1", progress: 4, total: 4 });
    await waitFor(() => view.get().get("tc:1")?.progress === 4);
    expect(view.get().get("tc:1")).toMatchObject({ fraction: 1 });

    await view.close();
  });
});
