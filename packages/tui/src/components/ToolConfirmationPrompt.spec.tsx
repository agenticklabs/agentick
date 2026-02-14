import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ToolConfirmationPrompt } from "./ToolConfirmationPrompt.js";
import type { ToolConfirmationRequest } from "@agentick/client";
import { flush } from "../testing.js";

function makeRequest(overrides: Partial<ToolConfirmationRequest> = {}): ToolConfirmationRequest {
  return {
    toolUseId: "tool-1",
    name: "delete_file",
    arguments: { path: "/tmp/test.txt" },
    ...overrides,
  };
}

describe("ToolConfirmationPrompt", () => {
  it("renders tool name and arguments", async () => {
    const { lastFrame } = render(<ToolConfirmationPrompt request={makeRequest()} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("delete_file");
    expect(frame).toContain("/tmp/test.txt");
    expect(frame).toContain("[Y] Approve");
    expect(frame).toContain("[N] Reject");
    expect(frame).toContain("[A] Always Allow");
  });

  it("shows message when present in request", async () => {
    const request = makeRequest({ message: "This will delete an important file" });
    const { lastFrame } = render(<ToolConfirmationPrompt request={request} />);
    await flush();

    expect(lastFrame()!).toContain("This will delete an important file");
  });

  it("truncates long arguments", async () => {
    const longArgs: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      longArgs[`key_${i}`] = `value_${i}`;
    }
    const request = makeRequest({ arguments: longArgs });
    const { lastFrame } = render(<ToolConfirmationPrompt request={request} />);
    await flush();

    expect(lastFrame()!).toContain("...");
  });

  it("renders diff view when metadata has type 'diff'", async () => {
    const request = makeRequest({
      name: "write_file",
      arguments: { path: "src/app.ts", content: "new content" },
      metadata: {
        type: "diff",
        filePath: "src/app.ts",
        patch: `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 import { foo } from "foo";
-const x = 1;
+const x = 42;
 export default x;
`,
        isNewFile: false,
      },
    });
    const { lastFrame } = render(<ToolConfirmationPrompt request={request} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("src/app.ts");
    expect(frame).toContain("const x = 42;");
    expect(frame).toContain("const x = 1;");
    // Should NOT show raw JSON arguments
    expect(frame).not.toContain('"content"');
  });
});
