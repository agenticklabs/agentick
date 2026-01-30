import { beforeEach, describe, expect, it } from "vitest";
import { TodoListTool } from "./todo-list.tool.js";
import { TodoListService } from "../services/todo-list.service.js";

async function runTool(input: Parameters<NonNullable<typeof TodoListTool.run>["exec"]>[0]) {
  const resultOrHandle = await TodoListTool.run!.exec(input);
  if (Array.isArray(resultOrHandle)) {
    return resultOrHandle;
  }
  return resultOrHandle.result;
}

describe("TodoListTool", () => {
  beforeEach(() => {
    TodoListService.clear("default");
  });

  it("creates a task using the title field", async () => {
    const result = await runTool({
      action: "create",
      title: "Test todo",
    });
    const text = result[0]?.type === "text" ? result[0].text : "";

    expect(text).toContain('Created task #1: "Test todo"');
    expect(text).toContain("○ [1] Test todo");
  });
});
