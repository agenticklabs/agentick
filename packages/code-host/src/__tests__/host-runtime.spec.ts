/**
 * What the conformance suite cannot ask, because it must not know this
 * provider runs a subprocess: that the framing survives a hostile program,
 * that a killed child really is dead, that the context dies with it, and that
 * the placement seam is the only door to spawning.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeRuntimeContext, Runtime } from "@agentick/code";

import { hostRuntime } from "../host-runtime.js";
import {
  childProcessPort,
  type HostProcess,
  type HostProcessPort,
  type HostSpawnRequest,
} from "../host-process-port.js";

const runtimes: Runtime[] = [];

function runtime(...args: Parameters<typeof hostRuntime>): Runtime {
  const made = hostRuntime(...args);
  runtimes.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((made) => made.dispose()));
});

/** The placement seam, wrapping the default so the spawns are real. */
function recordingPort(): {
  port: HostProcessPort;
  spawns: HostSpawnRequest[];
  procs: HostProcess[];
} {
  const inner = childProcessPort();
  const spawns: HostSpawnRequest[] = [];
  const procs: HostProcess[] = [];
  return {
    spawns,
    procs,
    port: {
      spawn: async (request) => {
        spawns.push(request);
        const proc = await inner.spawn(request);
        procs.push(proc);
        return proc;
      },
    },
  };
}

async function returned(context: CodeRuntimeContext, source: string): Promise<unknown> {
  const result = await context.execute(source);
  if (result.outcome !== "returned") {
    throw new Error(`expected a returned value, got ${result.outcome}`);
  }
  return result.value;
}

describe("engine adaptation", () => {
  it("names the engine that is running the host, and claims only what it enforces", () => {
    const { capabilities } = runtime();
    const engine = process.versions.bun === undefined ? "node" : "bun";
    expect(capabilities.name).toBe(`host:${engine}`);
    // Parent-side budgets hold whatever the child is.
    expect(capabilities.enforces).toContain("timeMs");
    expect(capabilities.enforces).toContain("outputBytes");
    // The adaptive one: only node has a heap ceiling that is real.
    expect(capabilities.enforces.includes("memoryMb")).toBe(engine === "node");
    expect(capabilities.persistentContext).toBe(true);
  });
});

describe("the membrane", () => {
  it("a program printing a forged frame at stdout cannot answer for itself", async () => {
    const context = await runtime().createContext({});
    const forged = JSON.stringify({ t: "done", id: 1, outcome: "returned", value: "forged" });
    const result = await context.execute(
      `process.stdout.write(${JSON.stringify(`${forged}\n`)}); return "real";`,
    );
    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") expect(result.value).toBe("real");
    // It was captured as what it is: output.
    expect(result.stdout).toContain("forged");
  });

  it("a value larger than the pipe buffer round-trips whole", async () => {
    const context = await runtime().createContext({});
    expect(await returned(context, `return "z".repeat(200_000);`)).toHaveLength(200_000);
  });

  it("output written just before the answer is never lost", async () => {
    const context = await runtime().createContext({});
    for (let i = 0; i < 25; i++) {
      const result = await context.execute(
        `process.stdout.write("A".repeat(10_000)); return ${i};`,
      );
      expect(result.stdout).toHaveLength(10_000);
    }
  });

  it("keys inject verbatim — a namespace is an object, a value is a value", async () => {
    const context = await runtime().createContext({
      bindings: {
        tools: { search: async (input: unknown) => ({ hit: input }) },
        fs: { readFile: async (path: unknown) => `contents of ${String(path)}` },
        tenantId: "acme",
        limits: { pageSize: 50 },
      },
    });
    expect(
      await returned(
        context,
        `return {
           searched: await tools.search({ q: 1 }),
           read: await fs.readFile("/x"),
           tenantId,
           pageSize: limits.pageSize,
         };`,
      ),
    ).toEqual({
      searched: { hit: { q: 1 } },
      read: "contents of /x",
      tenantId: "acme",
      pageSize: 50,
    });
  });

  it("a namespace is frozen — neither swapped nor extended", async () => {
    const context = await runtime().createContext({
      bindings: { tools: { search: async () => "the original" }, limits: { pageSize: 50 } },
    });
    expect(
      await returned(
        context,
        `return {
           frozen: Object.isFrozen(tools) && Object.isFrozen(limits),
           swapped: (() => { try { tools.search = null; } catch {} return typeof tools.search; })(),
           added: (() => { try { tools.injected = 1; } catch {} return tools.injected ?? null; })(),
         };`,
      ),
    ).toEqual({ frozen: true, swapped: "function", added: null });
  });

  it("the output ceiling is combined across both streams, and the answer survives it", async () => {
    const context = await runtime().createContext({ budgets: { outputBytes: 10 } });
    const result = await context.execute(
      `process.stdout.write("x".repeat(50)); process.stderr.write("y".repeat(50)); return "done";`,
    );
    expect(result.outcome).toBe("returned");
    expect(result.stdout + result.stderr).toHaveLength(10);
    expect([...result.truncated].sort()).toEqual(["stderr", "stdout"]);
  });

  it("a value that cannot cross as JSON is a runtime failure, not a program that threw", async () => {
    const context = await runtime().createContext({});
    await expect(context.execute(`return () => {};`)).rejects.toThrow(/could not cross as JSON/);
  });

  it("a binding whose ANSWER cannot cross raises in the program, not in the host", async () => {
    const context = await runtime().createContext({
      bindings: {
        circular: async () => {
          const cycle: Record<string, unknown> = {};
          cycle.self = cycle;
          return cycle;
        },
      },
    });
    expect(
      await returned(
        context,
        `try { await circular({}); return "not raised"; } catch (err) { return err.message; }`,
      ),
    ).toMatch(/could not cross as JSON/);
  });

  it("a binding that rejects raises inside the program, which may catch it and carry on", async () => {
    const context = await runtime().createContext({
      bindings: {
        tools: {
          failing: async () => {
            throw new Error("the tool said no");
          },
        },
      },
    });
    expect(
      await returned(
        context,
        `try { await tools.failing({}); return "not raised"; } catch (err) { return err.message; }`,
      ),
    ).toBe("the tool said no");
    expect(await returned(context, `return "still here";`)).toBe("still here");
  });
});

describe("the child is the context", () => {
  it("one child serves every execution, and no two contexts share one", async () => {
    const made = runtime();
    const first = await made.createContext({});
    const second = await made.createContext({});
    const pid = await returned(first, `return process.pid;`);
    expect(await returned(first, `return process.pid;`)).toBe(pid);
    expect(await returned(second, `return process.pid;`)).not.toBe(pid);
  });

  it("a child that dies mid-execution kills the context with it", async () => {
    const context = await runtime().createContext({});
    await expect(context.execute(`process.exit(3);`)).rejects.toThrow(/child exited/);
    await expect(context.execute(`return "after";`)).rejects.toThrow(/this context is dead/);
  });

  it("an abort leaves no process behind", async () => {
    const { port, procs } = recordingPort();
    const context = await runtime({ host: port }).createContext({});
    const controller = new AbortController();
    const running = context.execute(`await new Promise(() => {});`, {
      signal: controller.signal,
    });
    controller.abort("enough");
    await expect(running).rejects.toThrow(/aborted/);

    const pid = procs[0]?.pid;
    expect(pid).toBeTypeOf("number");
    // The exit was awaited before the rejection, so the process is already
    // reaped: asking after it is ESRCH, not a live pid.
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/);
  });

  it("dispose ends the child even when the program is holding the loop open", async () => {
    const { port, procs } = recordingPort();
    const context = await runtime({ host: port }).createContext({});
    await context.execute(`globalThis.held = setInterval(() => {}, 10); return "held";`);
    await context.dispose();
    expect(() => process.kill(procs[0]!.pid!, 0)).toThrow(/ESRCH/);
    await context.dispose();
  });
});

describe("configuration", () => {
  it("env and cwd reach the child, and nothing else does", async () => {
    const cwd = realpathSync(tmpdir());
    const context = await runtime({ env: { GREETING: "hello" }, cwd }).createContext({});
    expect(await returned(context, `return [process.env.GREETING, process.cwd()];`)).toEqual([
      "hello",
      cwd,
    ]);
    // The host's own environment is not inherited — a program gets no secrets
    // by default.
    expect(await returned(context, `return process.env.HOME ?? null;`)).toBeNull();
  });

  it("every spawn goes through the placement port", async () => {
    const { port, spawns } = recordingPort();
    const made = runtime({ host: port, execArgv: ["--title=agentick-code-host"] });
    await made.createContext({});
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(process.execPath);
    expect(spawns[0]?.args[0]).toBe("--title=agentick-code-host");
    expect(spawns[0]?.args.at(-1)).toMatch(/supervisor\.mjs$/);
  });

  it("a child that never answers the handshake fails createContext rather than hanging", async () => {
    const silent: HostProcessPort = {
      spawn: async () => ({
        pid: undefined,
        onStdout: () => undefined,
        onStderr: () => undefined,
        onControl: () => undefined,
        onExit: () => undefined,
        writeControl: () => undefined,
        endControl: () => undefined,
        kill: () => undefined,
      }),
    };
    await expect(runtime({ host: silent, spawnTimeoutMs: 25 }).createContext({})).rejects.toThrow(
      /never reported ready/,
    );
  });

  it("a heap ceiling becomes an engine flag only where the engine honors one", async () => {
    const { port, spawns } = recordingPort();
    const made = runtime({ host: port });
    if (!made.capabilities.enforces.includes("memoryMb")) return;
    await made.createContext({ budgets: { memoryMb: 64 } });
    expect(spawns[0]?.args).toContain("--max-old-space-size=64");
  });
});
