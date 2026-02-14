/**
 * DiffView Tests
 *
 * Validates that DiffView renders unified diffs with line numbers,
 * change markers, summary counts, and maxLines truncation.
 */

import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DiffView } from "./DiffView.js";
import { flush } from "../testing.js";

const SAMPLE_PATCH = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,5 +1,6 @@
 import { foo } from "foo";
+import { bar } from "bar";

 function main() {
-  return foo();
+  return bar(foo());
 }
`;

describe("DiffView", () => {
  it("renders addition lines with + marker", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} />);
    await flush();

    const frame = lastFrame()!;
    // Addition content should appear (without the leading + which is now a gutter marker)
    expect(frame).toContain('import { bar } from "bar"');
    expect(frame).toContain("return bar(foo());");
  });

  it("renders removal lines with - marker", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("return foo();");
    // Marker should be in the gutter
    expect(frame).toContain("-");
  });

  it("renders line numbers", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} />);
    await flush();

    const frame = lastFrame()!;
    // Line 1 context, line 2 addition, etc.
    expect(frame).toContain("1");
    expect(frame).toContain("2");
  });

  it("renders hunk headers", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("@@");
  });

  it("renders file path with change counts", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} filePath="src/main.ts" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("src/main.ts");
    expect(frame).toContain("+2");
    expect(frame).toContain("-1");
  });

  it("renders summary without file path", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("2 added");
    expect(frame).toContain("1 removed");
  });

  it("truncates with maxLines", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} maxLines={3} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("more line(s)");
  });

  it("does not show truncation message when lines fit", async () => {
    const { lastFrame } = render(<DiffView patch={SAMPLE_PATCH} maxLines={100} />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).not.toContain("more line(s)");
  });
});
