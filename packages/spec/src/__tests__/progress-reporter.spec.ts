/**
 * `createProgressReporter` — the four laws on {@link ProgressEventPayload},
 * enforced by construction (ADR 64).
 *
 * Every claim the reporter's docblock makes is pinned here: the opening frame,
 * monotonicity across both movement verbs, clamping to a known total, the
 * one-way ratchet (once, unchangeable, throwing on violation), that determinate
 * frames ALWAYS carry `total` while indeterminate ones NEVER do, `done`
 * idempotence, and the message-only frame.
 */

import { describe, expect, it } from "vitest";

import {
  createProgress,
  createProgressBegin,
  createProgressReporter,
  type ProgressUpdate,
} from "../data/signals.js";

/** Collect every frame an emitter is handed. */
function recorder(): { frames: ProgressUpdate[]; emit: (f: ProgressUpdate) => void } {
  const frames: ProgressUpdate[] = [];
  return { frames, emit: (f) => frames.push(f) };
}

describe("createProgressReporter — opening frame", () => {
  it("emits one frame at zero on construction, carrying a known total", () => {
    const { frames, emit } = recorder();
    createProgressReporter(emit, { total: 4, message: "starting" });
    expect(frames).toEqual([{ progress: 0, total: 4, message: "starting" }]);
  });

  it("emits an indeterminate opening frame when no total is known", () => {
    const { frames, emit } = recorder();
    createProgressReporter(emit);
    expect(frames).toEqual([{ progress: 0 }]);
  });

  it("ignores a non-positive or non-finite constructor total (never fakes a denominator)", () => {
    for (const total of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { frames, emit } = recorder();
      createProgressReporter(emit, { total });
      expect(frames[0]).toEqual({ progress: 0 });
    }
  });
});

describe("createProgressReporter — law 3, monotonic", () => {
  it("advance() defaults to 1 and accumulates", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance();
    p.advance(2, "two more");
    expect(frames.slice(1)).toEqual([{ progress: 1 }, { progress: 3, message: "two more" }]);
  });

  it("advance() with a negative or non-finite delta moves nothing but still reports", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance(5);
    p.advance(-4, "cannot go back");
    p.advance(Number.NaN);
    expect(frames.slice(1)).toEqual([
      { progress: 5 },
      { progress: 5, message: "cannot go back" },
      { progress: 5 },
    ]);
  });

  it("set() moves to an absolute value; a lower value is ignored, the message is not", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.set(7);
    p.set(3, "stale worker reported 3");
    expect(frames.slice(1)).toEqual([
      { progress: 7 },
      { progress: 7, message: "stale worker reported 3" },
    ]);
  });
});

describe("createProgressReporter — clamping to a known total", () => {
  it("advance() past the total clamps", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 3 });
    p.advance(10);
    expect(frames.at(-1)).toEqual({ progress: 3, total: 3 });
  });

  it("set() past the total clamps", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 3 });
    p.set(99);
    expect(frames.at(-1)).toEqual({ progress: 3, total: 3 });
  });
});

describe("createProgressReporter — law 2, the one-way ratchet", () => {
  it("total() learned mid-flight upgrades the stream and emits immediately", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance(2);
    p.total(10);
    expect(frames).toEqual([
      { progress: 0 },
      { progress: 2 },
      { progress: 2, total: 10 }, // the upgrade is visible without waiting for the next advance
    ]);
  });

  it("throws on a second total(), including one that repeats the same value", () => {
    const { emit } = recorder();
    const p = createProgressReporter(emit, { total: 5 });
    expect(() => p.total(9)).toThrow(/one-way/);
    expect(() => p.total(5)).toThrow(/one-way/);
  });

  it("throws on a total that is not a positive finite number", () => {
    const { emit } = recorder();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createProgressReporter(emit).total(bad)).toThrow(/positive finite/);
    }
  });

  it("clamps a count that already ran past the total it later learns", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance(12);
    p.total(10);
    expect(frames.at(-1)).toEqual({ progress: 10, total: 10 });
  });
});

describe("createProgressReporter — law 1, every frame classifies alone", () => {
  it("EVERY frame of a determinate stream carries total", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 3 });
    p.advance();
    p.note("still going");
    p.advance();
    p.done("finished");
    expect(frames.every((f) => f.total === 3)).toBe(true);
  });

  it("NO frame of an indeterminate stream carries total", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { message: "scanning" });
    p.advance(4);
    p.note("still scanning");
    p.done();
    expect(frames.every((f) => f.total === undefined)).toBe(true);
  });

  it("frames before the ratchet are indeterminate; every frame after it is determinate", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance();
    p.total(8);
    p.advance();
    expect(frames.map((f) => f.total)).toEqual([undefined, undefined, 8, 8]);
  });
});

describe("createProgressReporter — note()", () => {
  it("re-emits the current count with new text and moves nothing", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 6 });
    p.advance(2);
    p.note("waiting on the network");
    expect(frames.at(-1)).toEqual({ progress: 2, total: 6, message: "waiting on the network" });
  });
});

describe("createProgressReporter — done()", () => {
  it("fills the bar to total when known", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 5 });
    p.advance();
    p.done("all set");
    expect(frames.at(-1)).toEqual({ progress: 5, total: 5, message: "all set" });
  });

  it("reports the count reached when no total is known", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit);
    p.advance(3);
    p.done();
    expect(frames.at(-1)).toEqual({ progress: 3 });
  });

  it("is idempotent, and drops every emission that follows it", () => {
    const { frames, emit } = recorder();
    const p = createProgressReporter(emit, { total: 2 });
    p.done("done once");
    const after = frames.length;
    p.done("done twice");
    p.advance();
    p.set(2);
    p.note("late");
    expect(frames.length).toBe(after);
    expect(frames.at(-1)).toEqual({ progress: 2, total: 2, message: "done once" });
  });

  it("carries no terminal flag — law 4 keeps the frame byte-identical to the MCP shape", () => {
    const { frames, emit } = recorder();
    createProgressReporter(emit, { total: 1 }).done();
    expect(Object.keys(frames.at(-1) as object).sort()).toEqual(["progress", "total"]);
  });
});

describe("the callable-object surfaces", () => {
  it("createProgress keeps the raw two-argument door and mints reporters on the bound token", () => {
    const seen: Array<[unknown, ProgressUpdate]> = [];
    const progress = createProgress((token, frame) => seen.push([token, frame]), "call-1");

    progress("borrowed-token", { progress: 9, total: 9 }); // raw door — caller's own token
    progress.begin({ total: 2 }).advance();

    expect(seen).toEqual([
      ["borrowed-token", { progress: 9, total: 9 }],
      ["call-1", { progress: 0, total: 2 }],
      ["call-1", { progress: 1, total: 2 }],
    ]);
  });

  it("createProgressBegin exposes begin() alone for surfaces whose token is implicit", () => {
    const { frames, emit } = recorder();
    createProgressBegin(emit).begin({ message: "working" }).advance();
    expect(frames).toEqual([{ progress: 0, message: "working" }, { progress: 1 }]);
  });
});
