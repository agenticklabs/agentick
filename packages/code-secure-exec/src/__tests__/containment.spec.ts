/**
 * The reason this package exists: a program in the isolate reaches NOTHING but
 * the bindings it was handed. No `require`, no `import`, no `process`, no
 * `fetch`, no filesystem, no host global — containment by construction, with no
 * OS jail underneath. If any of these assertions fails, the package is not doing
 * the one job it has.
 *
 * The negative claims are asserted the honest way: a program that reads the
 * ambient name and reports what it found, run against the real isolate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCodeHarness, type FakeCodeHarnessBundle } from "@agentick/code/testing";

import { isolateRuntimeInstance } from "../testing/isolate-runtime-instance.js";

describe("containment — the isolate reaches nothing it was not handed", () => {
  let bundle: FakeCodeHarnessBundle;

  beforeEach(async () => {
    bundle = await fakeCodeHarness({ runtime: isolateRuntimeInstance() });
  });
  afterEach(async () => {
    await bundle.close();
  });

  async function evaluate(source: string): Promise<unknown> {
    const result = await bundle.harness.execute({ source });
    if (result.outcome !== "returned") {
      throw new Error(`expected a returned value, got ${result.outcome}`);
    }
    return result.value;
  }

  it.each([
    "require",
    "module",
    "exports",
    "process",
    "global",
    "globalThis.process",
    "fetch",
    "XMLHttpRequest",
    "Buffer",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "__dirname",
    "__filename",
  ])("`%s` is not reachable", async (name) => {
    expect(await evaluate(`return typeof ${name};`)).toBe("undefined");
  });

  it("require('fs') fails inside the isolate — there is no module system", async () => {
    const result = await bundle.harness.execute({
      source: `return require("fs").readFileSync("/etc/passwd");`,
    });
    expect(result.outcome).toBe("threw");
  });

  it("dynamic import fails — there is no host loader wired in", async () => {
    const result = await bundle.harness.execute({ source: `return await import("node:fs");` });
    expect(result.outcome).toBe("threw");
  });

  it("the global scope carries no host names — only what the bootstrap put there", async () => {
    const keys = (await evaluate("return Object.keys(globalThis);")) as string[];
    expect(keys).not.toContain("process");
    expect(keys).not.toContain("require");
    expect(keys).not.toContain("Buffer");
    expect(keys.filter((k) => k.startsWith("__agentick"))).toEqual([]);
  });

  it("an injected binding IS reachable — the one door, and it works", async () => {
    let reached = false;
    const result = await bundle.harness.execute({
      source: `return await net.fetch("https://example.com");`,
      bindings: {
        net: {
          fetch: async (url: unknown) => {
            reached = true;
            return { url, status: 200 };
          },
        },
      },
    });
    expect(reached).toBe(true);
    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") {
      expect(result.value).toEqual({ url: "https://example.com", status: 200 });
    }
  });

  it("a binding is the ONLY fetch — the ambient one is still undefined beside it", async () => {
    const result = await bundle.harness.execute({
      source: `return { ambient: typeof fetch, injected: typeof tools.fetch };`,
      bindings: { tools: { fetch: async () => null } },
    });
    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") {
      expect(result.value).toEqual({ ambient: "undefined", injected: "function" });
    }
  });

  it("a frozen namespace cannot be swapped — a program can't replace a binding", async () => {
    const result = await bundle.harness.execute({
      source: `
        try { tools.query = async () => "hijacked"; } catch {}
        return await tools.query({});
      `,
      bindings: { tools: { query: async () => "real" } },
    });
    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") expect(result.value).toBe("real");
  });

  it("a non-JSON-able argument is refused at the boundary, honestly", async () => {
    const result = await bundle.harness.execute({
      source: `try { await sink(() => 1); return "crossed"; } catch (e) { return "refused: " + (e && e.message); }`,
      bindings: { sink: async (v: unknown) => v },
    });
    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") {
      expect(String(result.value)).toContain("refused:");
    }
  });
});
