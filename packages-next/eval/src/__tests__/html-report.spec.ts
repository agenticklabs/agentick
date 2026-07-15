/**
 * `renderHtmlReport` smoke — a MatrixResult renders to a self-contained HTML
 * string carrying the cells, scores, tool trajectory, and a verdict.
 */

import { describe, expect, it } from "vitest";

import { renderHtmlReport } from "../html-report.js";
import type { MatrixResult } from "../types.js";

const matrix: MatrixResult<{ model: string }> = {
  passed: false,
  elapsedMs: 8421,
  cells: [
    {
      axes: { model: "gpt-4o-mini" },
      result: {
        description: "coding",
        passed: false,
        elapsedMs: 3120,
        assertions: [
          { kind: "completed", passed: true, message: "ok" },
          { kind: "calledTool", passed: true, message: "write_file called" },
          {
            kind: "expect",
            label: "greet + farewell run",
            passed: false,
            message: "ReferenceError: farewell is not defined",
          },
        ],
        scores: [
          { label: "quality", value: 0.62 },
          { label: "tokens", value: 4200 },
        ],
        toolCalls: [
          { name: "list_dir", input: {}, outcome: "succeeded", at: 1 },
          { name: "read_file", input: {}, outcome: "succeeded", at: 2 },
          { name: "write_file", input: {}, outcome: "succeeded", at: 3 },
          { name: "run_shell", input: {}, outcome: "failed", at: 4 },
        ],
      },
    },
    {
      axes: { model: "gpt-4o" },
      result: {
        description: "coding",
        passed: true,
        elapsedMs: 5301,
        assertions: [
          { kind: "completed", passed: true, message: "ok" },
          { kind: "expect", label: "greet + farewell run", passed: true, message: "ok" },
        ],
        scores: [
          { label: "quality", value: 0.95 },
          { label: "tokens", value: 8900 },
        ],
        toolCalls: [
          { name: "read_file", input: {}, outcome: "succeeded", at: 1 },
          { name: "write_file", input: {}, outcome: "succeeded", at: 2 },
          { name: "run_shell", input: {}, outcome: "succeeded", at: 3 },
        ],
      },
    },
  ],
};

describe("renderHtmlReport", () => {
  it("renders a full self-contained document with the run data", () => {
    const html = renderHtmlReport(matrix, { title: "Coding agent" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("Coding agent");
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("write_file"); // trajectory chip
    expect(html).toContain("quality"); // score column
    expect(html).toContain("1/2 cells passed"); // verdict
    // no external hosts (CSP-safe)
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("fragment mode omits the document skeleton", () => {
    const frag = renderHtmlReport(matrix, { fragment: true });
    expect(frag.startsWith("<style>")).toBe(true);
    expect(frag).not.toContain("<!doctype");
  });
});
