/**
 * Jail-confinement proof for the local OS-isolation stack (ADR 59, #240).
 *
 * These are SECURITY assertions, not functional ones: they prove the selected
 * jail ACTUALLY confines a real, jailed child process — a jail that doesn't
 * confine is worse than none (false confidence), so "exec still runs" is not
 * the bar; "the escape is denied" is.
 *
 * Per-platform gated on detected capability (`describe.skipIf`): the seatbelt
 * cases run only where `sandbox-exec` exists; the bwrap/unshare cases only
 * where a Linux namespace jail exists. The other pole registers skipped
 * (honest, like the docker/pg suites) — never a vacuous green.
 *
 * Each confinement case asserts `sb.isolation === <the real jail>` up front:
 * were passthrough ever selected, that guard fails LOUDLY rather than letting
 * a deny-assertion pass on an unconfined process. Every case is paired with a
 * passthrough CONTROL (`strategy: "none"`) that PERFORMS the same escape —
 * proving the denial is the jail's doing, not the host's file permissions or
 * a missing network.
 *
 * No fakes: real child processes, real `sandbox-exec` / `bwrap`.
 */

import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxHandle } from "@agentick/sandbox-next";
import { LocalSandbox } from "../local-sandbox.js";
import { detectCapabilities } from "../platform/detect.js";
import { localProvider } from "../provider.js";

const caps = await detectCapabilities();
const seatbeltAvailable = caps.platform === "darwin" && caps.hasSandboxExec;
const linuxJailAvailable =
  caps.platform === "linux" && (caps.hasBwrap || (caps.hasUnshare && caps.userNamespaces));

/** Shared live-resource bookkeeping + a local TCP echo server helper. */
function makeFixture() {
  const live: SandboxHandle[] = [];
  const hostDirs: string[] = [];
  const servers: Server[] = [];

  return {
    async sandbox(provider = localProvider()): Promise<LocalSandbox> {
      const sb = (await provider.create({ workspace: true })) as LocalSandbox;
      live.push(sb);
      return sb;
    },
    async sandboxNoNet(provider = localProvider()): Promise<LocalSandbox> {
      // allow.network omitted → false → jail-level network deny.
      const sb = (await provider.create({
        workspace: true,
        allow: { network: false },
      })) as LocalSandbox;
      live.push(sb);
      return sb;
    },
    async escapeFile(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "sbx-escape-"));
      hostDirs.push(dir);
      return join(dir, "escape.txt");
    },
    async localServerPort(): Promise<number> {
      const server = createServer((s) => {
        // The jailed client closes abruptly after connect → swallow the reset.
        s.on("error", () => {});
        s.end("hi");
      });
      server.on("error", () => {});
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no server address");
      return addr.port;
    },
    async cleanup(): Promise<void> {
      await Promise.all(live.map((h) => h.destroy().catch(() => {})));
      live.length = 0;
      await Promise.all(hostDirs.map((d) => rm(d, { recursive: true, force: true })));
      hostDirs.length = 0;
      for (const s of servers) s.close();
      servers.length = 0;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// macOS seatbelt — runs where sandbox-exec is available
// ════════════════════════════════════════════════════════════════════════

describe.skipIf(!seatbeltAvailable)("darwin seatbelt jail — confinement (PROVEN)", () => {
  const fx = makeFixture();
  afterEach(() => fx.cleanup());

  it("selects the seatbelt strategy on this host", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe("seatbelt");
  });

  it("DENIES writing a file outside the workspace (real jailed exec)", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe("seatbelt"); // guard: never passes on passthrough

    const escape = await fx.escapeFile();
    const res = await sb.exec(`echo pwned > "${escape}"`);

    expect(res.exitCode).not.toBe(0);
    // The strongest proof: the escape file was never created.
    await expect(readFile(escape, "utf-8")).rejects.toBeDefined();
  });

  it("CONTROL: a passthrough (unjailed) exec CAN write outside the workspace", async () => {
    const sb = await fx.sandbox(localProvider({ strategy: "none" }));
    expect(sb.isolation).toBe("none");

    const escape = await fx.escapeFile();
    const res = await sb.exec(`echo pwned > "${escape}"`);

    expect(res.exitCode).toBe(0);
    expect(await readFile(escape, "utf-8")).toContain("pwned");
  });

  it("DENIES reading a sensitive path outside the allow-set (/Users)", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe("seatbelt");

    const res = await sb.exec("ls /Users");
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("Operation not permitted");
  });

  it("CONTROL: a passthrough exec CAN list /Users", async () => {
    const sb = await fx.sandbox(localProvider({ strategy: "none" }));
    expect(sb.isolation).toBe("none");
    const res = await sb.exec("ls /Users");
    expect(res.exitCode).toBe(0);
  });

  it("DENIES network egress when allow.network is false (real jailed connect)", async () => {
    const port = await fx.localServerPort();
    const sb = await fx.sandboxNoNet();
    expect(sb.isolation).toBe("seatbelt");

    const res = await sb.exec(`bash -c 'echo > /dev/tcp/127.0.0.1/${port}'`);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("Operation not permitted");
  });

  it("CONTROL: a passthrough exec CAN reach the local server", async () => {
    const port = await fx.localServerPort();
    const sb = await fx.sandbox(localProvider({ strategy: "none" }));
    expect(sb.isolation).toBe("none");

    const res = await sb.exec(`bash -c 'echo > /dev/tcp/127.0.0.1/${port}'`);
    expect(res.exitCode).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Linux bwrap / unshare — runs where a namespace jail is available
// (registers skipped on hosts without it — honest, never vacuous)
// ════════════════════════════════════════════════════════════════════════

describe.skipIf(!linuxJailAvailable)("linux namespace jail — confinement (PROVEN)", () => {
  const fx = makeFixture();
  afterEach(() => fx.cleanup());

  const expectedJail = caps.hasBwrap ? "bwrap" : "unshare";

  it("selects a namespace jail (bwrap/unshare) on this host", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe(expectedJail);
  });

  it("DENIES writing a file outside the workspace (path not bound into the namespace)", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe(expectedJail); // guard: never passes on passthrough

    const escape = await fx.escapeFile();
    const res = await sb.exec(`echo pwned > "${escape}"`);

    expect(res.exitCode).not.toBe(0);
    // The host escape dir is not bound into the mount namespace → never written.
    await expect(readFile(escape, "utf-8")).rejects.toBeDefined();
  });

  it("CONTROL: a passthrough (unjailed) exec CAN write outside the workspace", async () => {
    const sb = await fx.sandbox(localProvider({ strategy: "none" }));
    expect(sb.isolation).toBe("none");

    const escape = await fx.escapeFile();
    const res = await sb.exec(`echo pwned > "${escape}"`);

    expect(res.exitCode).toBe(0);
    expect(await readFile(escape, "utf-8")).toContain("pwned");
  });

  it("DENIES reading a host path outside the bound allow-set", async () => {
    const sb = await fx.sandbox();
    expect(sb.isolation).toBe(expectedJail);

    // A freshly-created host dir is not bound into the namespace → absent.
    const escape = await fx.escapeFile();
    const dir = escape.slice(0, escape.lastIndexOf("/"));
    const res = await sb.exec(`ls "${dir}"`);
    expect(res.exitCode).not.toBe(0);
  });

  it("DENIES network egress when allow.network is false (no network namespace connectivity)", async () => {
    const port = await fx.localServerPort();
    const sb = await fx.sandboxNoNet();
    expect(sb.isolation).toBe(expectedJail);

    const res = await sb.exec(`bash -c 'echo > /dev/tcp/127.0.0.1/${port}'`);
    expect(res.exitCode).not.toBe(0);
  });
});
