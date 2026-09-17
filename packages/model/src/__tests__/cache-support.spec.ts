import { describe, expect, it } from "vitest";
import type { ExecutionTarget, LanguageModelMessage } from "@agentick/spec";

import { applyCacheSupport } from "../cache-support.js";

const MIN = 60_000;
const target = (
  cache?: ExecutionTarget["capabilities"] extends infer C
    ? C extends { cache?: infer K }
      ? K
      : never
    : never,
): ExecutionTarget =>
  ({
    kind: "language-model",
    provider: "p",
    modelId: "m",
    capabilities: cache === undefined ? {} : { cache },
  }) as ExecutionTarget;
const breakpoints = target({ ttlMs: 5 * MIN, explicit: { kind: "breakpoint", maxBoundaries: 4 } });
const implicit = target({});

const user = (text: string, ttlMs?: number): LanguageModelMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    ...(ttlMs !== undefined ? { cache: { ttlMs } } : {}),
  }) as LanguageModelMessage;
const system = (parts: [string, number?][]): LanguageModelMessage =>
  ({
    role: "system",
    content: parts.map(([text, ttlMs]) => ({
      type: "text",
      text,
      ...(ttlMs !== undefined ? { cache: { ttlMs } } : {}),
    })),
  }) as LanguageModelMessage;

describe("applyCacheSupport", () => {
  it("returns the messages by identity when nothing is declared, whatever the target", () => {
    const messages = [user("hi")];
    expect(applyCacheSupport(messages, implicit).messages).toBe(messages);
    expect(applyCacheSupport(messages, breakpoints).messages).toBe(messages);
  });

  it("declines every boundary on a target that caches on its own terms, and strips them from the wire", () => {
    const messages = [system([["stable", 60 * MIN]]), user("hi", 5 * MIN)];
    const { messages: out, declined } = applyCacheSupport(messages, implicit);
    expect(declined.map((d) => [d.messageIndex, d.partIndex, d.ttlMs])).toEqual([
      [0, 0, 60 * MIN],
      [1, undefined, 5 * MIN],
    ]);
    expect(declined[0]!.reason).toContain("caches on its own terms");
    expect((out[0]!.content as readonly { cache?: unknown }[])[0]).not.toHaveProperty("cache");
    expect(out[1]).not.toHaveProperty("cache");
  });

  it("keeps a well-formed set untouched: longer lifetimes first, within the limit", () => {
    const messages = [
      system([
        ["persona", 60 * MIN],
        ["catalog", 60 * MIN],
      ]),
      user("old", 5 * MIN),
      user("now"),
    ];
    const { messages: out, declined } = applyCacheSupport(messages, breakpoints);
    expect(declined).toEqual([]);
    expect(out).toBe(messages);
  });

  it("declines a longer lifetime that comes after a shorter one", () => {
    const messages = [user("a", 5 * MIN), user("b", 60 * MIN), user("c", 5 * MIN)];
    const { messages: out, declined } = applyCacheSupport(messages, breakpoints);
    expect(declined.map((d) => d.messageIndex)).toEqual([1]);
    expect(declined[0]!.reason).toContain("longer lifetime must come before");
    expect(out[1]).not.toHaveProperty("cache");
    expect(out[0]).toHaveProperty("cache");
    expect(out[2]).toHaveProperty("cache");
  });

  it("keeps the boundaries nearest the end when more are declared than the target takes", () => {
    const messages = ["a", "b", "c", "d", "e", "f"].map((t) => user(t, 5 * MIN));
    const { messages: out, declined } = applyCacheSupport(messages, breakpoints);
    expect(declined.map((d) => d.messageIndex)).toEqual([0, 1]);
    expect(declined[0]!.reason).toContain("takes 4 boundaries");
    expect(out.map((m) => "cache" in m)).toEqual([false, false, true, true, true, true]);
  });
});
