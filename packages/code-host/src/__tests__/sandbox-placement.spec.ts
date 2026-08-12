/**
 * The containment pin (#285).
 *
 * `hostRuntime()` on its own is placement, not containment: model-authored
 * code runs as a child of the host app, so `fetch` reaches the internet and
 * `node:fs` reaches the home directory. These cases run the SAME runtime
 * through `sandboxHostPort` and assert that exact leak set is closed —
 * while the two things a program is there to do, calling its bindings and
 * writing its workspace, still work.
 *
 * Real jail, real subprocess, real seatbelt/bwrap. Every denial is paired
 * with an unjailed CONTROL that performs the leak, so a green here can never
 * mean "the network was down" or "the file wasn't there".
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeRuntimeContext, Runtime } from "@agentick/code";
import { SandboxUnsupportedError, type SandboxHandle } from "@agentick/sandbox";
import { localProvider } from "@agentick/sandbox-local";

import { sandboxHostPort } from "../sandbox-host-port.js";
import { hostRuntimeInstance } from "../testing/host-runtime-instance.js";

// Gate on what this host can actually do: `isolation` is the provider's
// honest claim, and "none" means the suite would prove nothing.
const probe = await localProvider().create({ workspace: true });
const jailAvailable = (probe as SandboxHandle & { isolation?: string }).isolation !== "none";
await probe.destroy();

const live: { runtimes: Runtime[]; sandboxes: SandboxHandle[]; dirs: string[]; servers: Server[] } =
  { runtimes: [], sandboxes: [], dirs: [], servers: [] };

afterEach(async () => {
  await Promise.all(live.runtimes.splice(0).map((r) => r.dispose()));
  await Promise.all(live.sandboxes.splice(0).map((s) => s.destroy().catch(() => {})));
  await Promise.all(live.dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  for (const s of live.servers.splice(0)) s.close();
});

/** A file in the home directory — the read the loss audit found unguarded. */
async function homeSecret(): Promise<string> {
  const dir = await mkdtemp(join(homedir(), ".agentick-code-host-test-"));
  live.dirs.push(dir);
  const path = join(dir, "credentials");
  await writeFile(path, "aws_secret_access_key = TOP-SECRET\n");
  return path;
}

/** A local HTTP server, so "egress denied" is never just "the host is offline". */
async function reachableUrl(): Promise<string> {
  const server = createServer((s) => {
    s.on("error", () => {});
    s.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("error", () => {});
  live.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  return `http://127.0.0.1:${address.port}/`;
}

/** The bound tool a program is supposed to keep, whatever the placement. */
const bindings = { tools: { lookup: async (id: unknown) => `record:${String(id)}` } };

async function jailedContext(): Promise<{ context: CodeRuntimeContext; sandbox: SandboxHandle }> {
  const sandbox = await localProvider().create({ workspace: true, allow: { network: false } });
  live.sandboxes.push(sandbox);
  const runtime = hostRuntimeInstance({ host: sandboxHostPort(sandbox) });
  live.runtimes.push(runtime);
  return { context: await runtime.createContext({ bindings }), sandbox };
}

async function unjailedContext(): Promise<CodeRuntimeContext> {
  const runtime = hostRuntimeInstance();
  live.runtimes.push(runtime);
  return runtime.createContext({ bindings });
}

describe("the placement refuses a handle that cannot host a process", () => {
  it("throws at wiring time, not on the first program", () => {
    const handle = { id: "x", workspacePath: "/w" } as unknown as SandboxHandle;
    expect(() => sandboxHostPort(handle)).toThrow(SandboxUnsupportedError);
  });
});

describe.skipIf(!jailAvailable)("code-host placed in a sandbox — containment (PROVEN)", () => {
  it("a jailed program still calls its bound tools", async () => {
    const { context } = await jailedContext();
    const result = await context.execute(`return await tools.lookup(7);`);
    expect(result).toMatchObject({ outcome: "returned", value: "record:7" });
  });

  it("a jailed program still writes its workspace", async () => {
    const { context, sandbox } = await jailedContext();
    const result = await context.execute(
      `const fs = await import("node:fs/promises");
       await fs.writeFile("report.txt", "from the program");
       return "wrote";`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "wrote" });
    expect(await sandbox.readFile("report.txt")).toBe("from the program");
  });

  it("DENIES fetch to a host that is demonstrably reachable", async () => {
    const url = await reachableUrl();
    const { context } = await jailedContext();
    const result = await context.execute(
      `try { const r = await fetch(${JSON.stringify(url)}); return "status:" + r.status; }
       catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "denied" });
  });

  it("CONTROL: the same program unjailed reaches that host", async () => {
    const url = await reachableUrl();
    const context = await unjailedContext();
    const result = await context.execute(
      `try { const r = await fetch(${JSON.stringify(url)}); return "status:" + r.status; }
       catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "status:204" });
  });

  it("DENIES reading a credentials file in the home directory", async () => {
    const secret = await homeSecret();
    const { context } = await jailedContext();
    const result = await context.execute(
      `const fs = await import("node:fs/promises");
       try { return await fs.readFile(${JSON.stringify(secret)}, "utf8"); }
       catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "denied" });
  });

  it("CONTROL: the same program unjailed reads that file", async () => {
    const secret = await homeSecret();
    const context = await unjailedContext();
    const result = await context.execute(
      `const fs = await import("node:fs/promises");
       try { return await fs.readFile(${JSON.stringify(secret)}, "utf8"); }
       catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({
      outcome: "returned",
      value: expect.stringContaining("TOP-SECRET"),
    });
  });

  it("starts without reading the package.json that would type the supervisor", async () => {
    const { context } = await jailedContext();
    // The jail grants the supervisor file and nothing around it, so the
    // engine cannot consult `"type": "module"`. `.mjs` is what makes the
    // child ESM by extension instead of by whatever the engine infers —
    // node only auto-detects module syntax from 22.7, and this package
    // supports 20.19.
    const result = await context.execute(
      `const fs = await import("node:fs/promises");
       const path = await import("node:path");
       const pkg = path.join(path.dirname(process.argv[1]), "..", "package.json");
       try { await fs.readFile(pkg, "utf8"); return "read"; } catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "denied" });
  });

  it("DENIES overwriting the supervisor that runs it", async () => {
    const { context } = await jailedContext();
    const supervisor = await context.execute(`return process.argv[1];`);
    expect(supervisor).toMatchObject({ outcome: "returned" });
    const path = (supervisor as { value: string }).value;
    const before = await readFile(path, "utf8");

    const result = await context.execute(
      `const fs = await import("node:fs/promises");
       try { await fs.writeFile(process.argv[1], "pwned"); return "wrote"; }
       catch (err) { return "denied"; }`,
    );
    expect(result).toMatchObject({ outcome: "returned", value: "denied" });
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
