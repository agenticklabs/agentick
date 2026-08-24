import { describe, expect, it } from "vitest";
import type { ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { toToolInfo } from "../tools-handle.js";

const base: ToolDeclaration = {
  id: "list_jobs",
  name: "list_jobs",
  description: "List jobs",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
};

describe("toToolInfo — capability-tree fields", () => {
  it("carries summary + group", () => {
    const info = toToolInfo({ ...base, summary: "Lists the open jobs.", group: ["api", "jobs"] });
    expect(info.summary).toBe("Lists the open jobs.");
    expect(info.group).toEqual(["api", "jobs"]);
  });

  it("omits both keys when the declaration has neither", () => {
    const info = toToolInfo(base);
    expect(info).not.toHaveProperty("summary");
    expect(info).not.toHaveProperty("group");
  });
});
