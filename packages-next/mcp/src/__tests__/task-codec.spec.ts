/**
 * Wire codec tests — discriminator branching + error clarity.
 *
 * `discriminateCallToolResponse` previously chained `safeParse` calls
 * and threw a generic "neither matched" message. The hardened version
 * inspects the structural discriminator (`task` vs `content` field),
 * then strict-parses the matching schema so field-level errors
 * surface. These tests pin both the happy paths and the clarified
 * failure messages.
 */

import { describe, expect, it } from "vitest";

import { discriminateCallToolResponse } from "../wire/task-codec.js";

describe("discriminateCallToolResponse", () => {
  it("discriminates a CallToolResult (inline) shape", () => {
    const out = discriminateCallToolResponse({
      content: [{ type: "text", text: "hi" }],
    });
    expect(out._tag).toBe("inline");
    if (out._tag === "inline") {
      expect(out.result.content).toEqual([{ type: "text", text: "hi" }]);
    }
  });

  it("discriminates a CreateTaskResult (task) shape", () => {
    const out = discriminateCallToolResponse({
      task: {
        taskId: "task:1",
        status: "working",
        ttl: null,
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(out._tag).toBe("task");
    if (out._tag === "task") {
      expect(out.result.task.taskId).toBe("task:1");
    }
  });

  it("non-object input throws a clear error", () => {
    expect(() => discriminateCallToolResponse(null)).toThrowError(/not an object/);
    expect(() => discriminateCallToolResponse(undefined)).toThrowError(/not an object/);
    expect(() => discriminateCallToolResponse("string")).toThrowError(/not an object/);
    expect(() => discriminateCallToolResponse(42)).toThrowError(/not an object/);
  });

  it("response with neither `task` nor `content` throws a clear error", () => {
    expect(() => discriminateCallToolResponse({})).toThrowError(/neither `task`.*nor `content`/);
    expect(() => discriminateCallToolResponse({ unrelated: true })).toThrowError(
      /neither `task`.*nor `content`/,
    );
  });

  it("malformed `task` shape (missing required fields) surfaces field-level Zod errors", () => {
    // `task` is present but missing required `taskId` → Zod throws with detail.
    expect(() =>
      discriminateCallToolResponse({
        task: { status: "working", ttl: null, createdAt: "x", lastUpdatedAt: "y" },
      }),
    ).toThrowError(/taskId/);
  });

  it("malformed `task.status` enum value surfaces a clear schema error", () => {
    // status: "bogus" is not in the TaskStatus enum.
    expect(() =>
      discriminateCallToolResponse({
        task: {
          taskId: "task:1",
          status: "bogus",
          ttl: null,
          createdAt: "x",
          lastUpdatedAt: "y",
        },
      }),
    ).toThrowError(/status|enum|bogus/i);
  });

  it("when both `task` AND `content` present, CreateTaskResult wins (spec violation; deterministic)", () => {
    const out = discriminateCallToolResponse({
      task: {
        taskId: "task:1",
        status: "working",
        ttl: null,
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:00Z",
      },
      content: [{ type: "text", text: "also here" }],
    });
    expect(out._tag).toBe("task");
  });

  it("`task` field that's null (not an object) is NOT treated as task — falls through to content/error", () => {
    // task: null shouldn't be parsed as CreateTaskResult.
    // Has neither valid task NOR content → error path.
    expect(() => discriminateCallToolResponse({ task: null })).toThrowError(
      /neither `task`.*nor `content`/,
    );
    // task: null + content present → treated as inline.
    const out = discriminateCallToolResponse({
      task: null,
      content: [{ type: "text", text: "ok" }],
    });
    expect(out._tag).toBe("inline");
  });
});
