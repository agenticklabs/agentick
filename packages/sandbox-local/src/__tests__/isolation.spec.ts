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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxHandle, SandboxProcess } from "@agentick/sandbox";
import { LocalSandbox } from "../local-sandbox.js";
import { detectCapabilities } from "../platform/detect.js";
import { localProvider } from "../provider.js";

const caps = await detectCapabilities();
/** Terminates every reply on the probe loop's control channel. */
const DONE = "--done--";
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
    /**
     * A file in the user's home directory — the read the jail is supposed to
     * refuse (`~/.aws/credentials` and friends). The system temp dir is NOT
     * that: the profile denies reads under `/Users`, not under `/var/folders`,
     * so an escape file there is readable by design.
     */
    async homeFile(content: string): Promise<string> {
      const dir = await mkdtemp(join(homedir(), ".agentick-sandbox-test-"));
      hostDirs.push(dir);
      const path = join(dir, "secret.txt");
      await writeFile(path, content);
      return path;
    },
    async unixServerAt(socketPath: string): Promise<string> {
      const server = createServer((s) => {
        s.on("error", () => {});
        s.end("hi");
      });
      server.on("error", () => {});
      servers.push(server);
      server.listen(socketPath);
      await once(server, "listening");
      return socketPath;
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

/**
 * Drive a spawned process over its control channel: send a shell command,
 * read back everything it produced. The point is that this happens WHILE the
 * process runs — a jail that only survives `exec` would never get here.
 */
function driver(proc: SandboxProcess): {
  ready: () => Promise<void>;
  run: (command: string) => Promise<string>;
  end: () => Promise<void>;
} {
  let buffered = "";
  const lines: string[] = [];
  // One reply is outstanding at a time — the driver sends the next command
  // only after the previous one answered.
  let pending: (() => void) | undefined;
  proc.onControl((chunk) => {
    buffered += chunk.toString();
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      lines.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
    pending?.();
  });
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));

  const untilDone = (): Promise<string[]> =>
    new Promise((resolve) => {
      const check = (): void => {
        const at = lines.indexOf(DONE);
        if (at < 0) return;
        pending = undefined;
        resolve(lines.splice(0, at + 1).slice(0, -1));
      };
      pending = check;
      check();
    });

  return {
    ready: async () => void (await untilDone()),
    run: async (command) => {
      proc.writeControl(`${command}\n`);
      return (await untilDone()).join("\n");
    },
    end: async () => {
      proc.endControl();
      await exited;
    },
  };
}

/** Announce, then answer one command per line — every reply terminated by DONE. */
const PROBE_LOOP = `echo ${DONE} >&3; while read cmd; do eval "$cmd" >&3 2>&3; echo ${DONE} >&3; done`;

async function probe(
  sb: LocalSandbox,
  readablePaths?: readonly string[],
): Promise<ReturnType<typeof driver>> {
  const proc = await sb.spawn({
    command: "/bin/sh",
    args: ["-c", PROBE_LOOP],
    ...(readablePaths === undefined ? {} : { readablePaths }),
  });
  const drive = driver(proc);
  await drive.ready();
  return drive;
}

// ════════════════════════════════════════════════════════════════════════
// Jailed spawn (#285) — a LIVE process, confined, with its control channel
// intact. `exec` is fire-and-collect; a supervisor calls back mid-run, so
// the jail has to hold while a descriptor stays open across it.
// ════════════════════════════════════════════════════════════════════════

describe.skipIf(!seatbeltAvailable && !linuxJailAvailable)(
  "jailed spawn — confinement (PROVEN)",
  () => {
    const fx = makeFixture();
    afterEach(() => fx.cleanup());

    const realJail = seatbeltAvailable ? "seatbelt" : caps.hasBwrap ? "bwrap" : "unshare";

    it("the control channel (fd 3) survives the jail, bidirectionally", async () => {
      const sb = await fx.sandboxNoNet();
      expect(sb.isolation).toBe(realJail); // guard: never passes on passthrough

      const drive = await probe(sb);
      expect(await drive.run("echo first")).toBe("first");
      expect(await drive.run("echo second")).toBe("second");
      await drive.end();
    });

    it("DENIES a spawned process reading a file outside the workspace", async () => {
      const sb = await fx.sandboxNoNet();
      expect(sb.isolation).toBe(realJail);
      const secret = await fx.homeFile("TOP-SECRET\n");

      const drive = await probe(sb);
      expect(await drive.run(`cat "${secret}"`)).not.toContain("TOP-SECRET");
      await drive.end();
    });

    it("CONTROL: a passthrough spawn CAN read that same file", async () => {
      const sb = await fx.sandbox(localProvider({ strategy: "none" }));
      expect(sb.isolation).toBe("none");
      const secret = await fx.homeFile("TOP-SECRET\n");

      const drive = await probe(sb);
      expect(await drive.run(`cat "${secret}"`)).toContain("TOP-SECRET");
      await drive.end();
    });

    it("DENIES a spawned process reaching the network", async () => {
      const port = await fx.localServerPort();
      const sb = await fx.sandboxNoNet();
      expect(sb.isolation).toBe(realJail);

      const drive = await probe(sb);
      const reached = await drive.run(
        `bash -c 'echo > /dev/tcp/127.0.0.1/${port}' && echo REACHED`,
      );
      expect(reached).not.toContain("REACHED");
      await drive.end();
    });

    it("CONTROL: a passthrough spawn CAN reach the local server", async () => {
      const port = await fx.localServerPort();
      const sb = await fx.sandbox(localProvider({ strategy: "none" }));
      expect(sb.isolation).toBe("none");

      const drive = await probe(sb);
      const reached = await drive.run(
        `bash -c 'echo > /dev/tcp/127.0.0.1/${port}' && echo REACHED`,
      );
      expect(reached).toContain("REACHED");
      await drive.end();
    });

    it("ALLOWS a workspace write, so a confined program is still useful", async () => {
      const sb = await fx.sandboxNoNet();
      expect(sb.isolation).toBe(realJail);

      const drive = await probe(sb);
      await drive.run(`echo written > "${sb.workspacePath}/out.txt"`);
      await drive.end();
      expect(await sb.readFile("out.txt")).toContain("written");
    });

    it("readablePaths grants exactly the declared path, and only for reading", async () => {
      const sb = await fx.sandboxNoNet();
      expect(sb.isolation).toBe(realJail);
      const granted = await fx.homeFile("SUPERVISOR-SOURCE\n");
      const ungranted = await fx.homeFile("TOP-SECRET\n");

      const drive = await probe(sb, [granted]);
      expect(await drive.run(`cat "${granted}"`)).toContain("SUPERVISOR-SOURCE");
      expect(await drive.run(`cat "${ungranted}"`)).not.toContain("TOP-SECRET");
      // A supervisor whose own script the program can rewrite is no supervisor.
      await drive.run(`echo pwned > "${granted}"`);
      await drive.end();
      expect(await readFile(granted, "utf-8")).toBe("SUPERVISOR-SOURCE\n");
    });
  },
);

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

  it("ALLOWS an AF_UNIX connect under the workspace while network stays denied (#274)", async () => {
    const sb = await fx.sandboxNoNet();
    expect(sb.isolation).toBe("seatbelt");
    const sock = await fx.unixServerAt(join(sb.workspacePath, "ctl.sock"));

    const res = await sb.exec(`nc -U "${sock}" < /dev/null`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hi");
  });

  it("DENIES an AF_UNIX connect outside the workspace under the same deny (#274)", async () => {
    const sb = await fx.sandboxNoNet();
    expect(sb.isolation).toBe("seatbelt");
    const outsideDir = dirname(await fx.escapeFile());
    const sock = await fx.unixServerAt(join(outsideDir, "outside.sock"));

    const res = await sb.exec(`nc -U "${sock}" < /dev/null`);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toContain("hi");
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
