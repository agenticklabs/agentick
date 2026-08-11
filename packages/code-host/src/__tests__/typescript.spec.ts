/**
 * `language: "typescript"` — what the JavaScript vocabulary cannot ask, because
 * every program it writes is already valid in both languages.
 *
 * The additivity claim itself is pinned in `provider-conformance.spec.ts`,
 * which runs the whole JavaScript suite against a TypeScript-mode runtime.
 * What is here is the difference: syntax that only TypeScript accepts, and the
 * line between stripping types and checking them.
 *
 * @verifiedBy this file
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeExecuteInput, CodeExecuteResult, Runtime } from "@agentick/code";
import { fakeCodeHarness } from "@agentick/code/testing";

import { hostRuntime, type HostLanguage } from "../index.js";

const runtimes: Runtime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((made) => made.dispose()));
});

async function run(
  source: string,
  language: HostLanguage = "typescript",
): Promise<CodeExecuteResult> {
  const runtime = hostRuntime({ language });
  runtimes.push(runtime);
  const context = await runtime.createContext({});
  return context.execute(source);
}

describe("TypeScript is a mode of this provider, not a second one", () => {
  it("marks the language in the capability name", () => {
    const engine = process.versions.bun === undefined ? "node" : "bun";
    expect(hostRuntime({ language: "typescript" }).capabilities.name).toBe(`host:${engine}+ts`);
    expect(hostRuntime().capabilities.name).toBe(`host:${engine}`);
  });

  it("runs a program whose annotations have no runtime form", async () => {
    const result = await run(`
      const total: number = 41;
      const label: string = "answer";
      return { [label]: total + 1 };
    `);
    expect(result).toMatchObject({ outcome: "returned", value: { answer: 42 } });
  });

  it("runs a program built out of declaration-only syntax", async () => {
    const result = await run(`
      interface Row { id: string; late: boolean }
      type Summary = Pick<Row, "id">;
      const rows = JSON.parse('[{"id":"a","late":true},{"id":"b","late":false}]') as Row[];
      const late: Summary[] = rows.filter((row) => row.late).map(({ id }) => ({ id }));
      return late;
    `);
    expect(result).toMatchObject({ outcome: "returned", value: [{ id: "a" }] });
  });

  it("keeps the async-function body — top-level await and return still work", async () => {
    const runtime = hostRuntime({ language: "typescript" });
    runtimes.push(runtime);
    const context = await runtime.createContext({
      bindings: { fetchRow: async (input: unknown) => ({ echoed: input }) },
    });
    const result = await context.execute(`
      const answer: unknown = await fetchRow({ id: "a" });
      return answer;
    `);
    expect(result).toMatchObject({ outcome: "returned", value: { echoed: { id: "a" } } });
  });

  it("EXECUTES a program with a type error — this is a transpiler, not a typechecker", async () => {
    // The documented behavior, pinned so nobody reads `language: "typescript"`
    // as a gate. `tsc` rejects this program; esbuild erases the annotation and
    // the engine runs what is left.
    const result = await run(`
      const count: number = "seven";
      return typeof count;
    `);
    expect(result).toMatchObject({ outcome: "returned", value: "string" });
  });

  it("reports source that will not PARSE the way the engine reports its own", async () => {
    const result = await run(`const = ;`);
    expect(result).toMatchObject({ outcome: "threw", error: { name: "SyntaxError" } });
    if (result.outcome !== "threw") throw new Error("expected a thrown outcome");
    // The location is the caller's program, not the wrapper it was parsed in.
    expect(result.error.message).toContain("(1:7)");
  });

  it("is the mode that makes the difference — JavaScript refuses the same program", async () => {
    const annotated = `const total: number = 1; return total;`;
    expect(await run(annotated, "typescript")).toMatchObject({ outcome: "returned", value: 1 });
    expect(await run(annotated, "javascript")).toMatchObject({
      outcome: "threw",
      error: { name: "SyntaxError" },
    });
  });

  it("audits the program the ADOPTER wrote, not the JavaScript it became", async () => {
    // Transpilation happens inside the provider, BELOW the audit boundary, so
    // the record a guard reads and the digest that keys it are both over the
    // source as written. Hashing the transpiled text instead would make an
    // allowlist entry depend on which esbuild version ran.
    const runtime = hostRuntime({ language: "typescript" });
    runtimes.push(runtime);
    const { harness, close } = await fakeCodeHarness({ runtime });
    const program = `const total: number = 41;\nreturn total + 1;`;

    const audited: CodeExecuteInput[] = [];
    harness.hook({
      onBeforeCodeExecute: (input: CodeExecuteInput) => {
        audited.push(input);
        return input;
      },
    });

    expect(await harness.execute({ source: program })).toMatchObject({
      outcome: "returned",
      value: 42,
    });
    expect(audited[0]?.source).toBe(program);
    expect(audited[0]?.codeHash).toBe(createHash("sha256").update(program).digest("hex"));

    await close();
  });
});
