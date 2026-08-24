import { describe, expect, it } from "vitest";
import type { ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTool } from "../create-tool.js";
import { createToolGroup } from "../tool-group.js";

const declaration = (name: string, group?: readonly string[]): ToolDeclaration => ({
  id: name,
  name,
  description: name,
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  ...(group !== undefined ? { group } : {}),
});

describe("createToolGroup", () => {
  it("stamps its name onto every member", () => {
    const flat = createToolGroup({ name: "jobs", tools: [declaration("list_jobs")] });
    expect(flat.map((t) => t.name)).toEqual(["list_jobs"]);
    expect(flat[0]!.group).toEqual(["jobs"]);
  });

  it("prefixes the parent segment onto a nested group's path", () => {
    const flat = createToolGroup({
      name: "jobs",
      tools: [
        declaration("list_jobs"),
        createToolGroup({ name: "drafts", tools: [declaration("create_draft")] }),
      ],
    });
    expect(flat.map((t) => [t.name, t.group])).toEqual([
      ["list_jobs", ["jobs"]],
      ["create_draft", ["jobs", "drafts"]],
    ]);
  });

  it("prefixes onto a path the tool already declared", () => {
    const flat = createToolGroup({ name: "jobs", tools: [declaration("legacy", ["x"])] });
    expect(flat[0]!.group).toEqual(["jobs", "x"]);
  });

  it("prefixes through three levels", () => {
    const flat = createToolGroup({
      name: "api",
      tools: [
        createToolGroup({
          name: "jobs",
          tools: [createToolGroup({ name: "drafts", tools: [declaration("create_draft")] })],
        }),
      ],
    });
    expect(flat[0]!.group).toEqual(["api", "jobs", "drafts"]);
  });

  it("accepts a CreatedTool bundle and a bare declaration side by side", () => {
    const created = createTool({
      name: "run_job",
      description: "Run a job",
      handler: async () => "ok",
    });
    const flat = createToolGroup({ name: "jobs", tools: [created, declaration("list_jobs")] });
    expect(flat.map((t) => t.name)).toEqual(["run_job", "list_jobs"]);
    expect(flat.every((t) => t.group?.[0] === "jobs")).toBe(true);
    expect(flat[0]!.handlerRef).toBe(created.handlerRef);
  });

  it("leaves the source declaration unmutated", () => {
    const source = declaration("list_jobs");
    createToolGroup({ name: "jobs", tools: [source] });
    expect(source).not.toHaveProperty("group");
  });
});

describe("createTool — summary + group", () => {
  it("lands both on the declaration", () => {
    const t = createTool({
      name: "list_jobs",
      description: "List jobs",
      summary: "Lists the open jobs.",
      group: ["api", "jobs"],
      handler: async () => "ok",
    });
    expect(t.declaration.summary).toBe("Lists the open jobs.");
    expect(t.declaration.group).toEqual(["api", "jobs"]);
  });

  it("lands both on a client-handled declaration", () => {
    const t = createTool({
      name: "open_file",
      description: "Open a file",
      summary: "Opens a file in the editor.",
      group: ["editor"],
    });
    expect(t.declaration.summary).toBe("Opens a file in the editor.");
    expect(t.declaration.group).toEqual(["editor"]);
  });

  it("omits both keys when unset", () => {
    const t = createTool({ name: "x", description: "y", handler: async () => "ok" });
    expect(t.declaration).not.toHaveProperty("summary");
    expect(t.declaration).not.toHaveProperty("group");
  });
});
