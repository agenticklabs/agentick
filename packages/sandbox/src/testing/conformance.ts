/**
 * Conformance suite for {@link SandboxProvider} implementations (#218).
 *
 * The executable form of the ADR 59 provider contract. Any provider —
 * `@agentick/sandbox-local` (reference), `@agentick/sandbox-docker`, a future
 * remote/secure-exec — runs this suite against a REAL instance (real
 * processes, real temp dirs) to claim conformance. It pins:
 *
 *   - `exec`: stdout/stderr/exitCode, and live streaming via `onOutput`.
 *   - `readFile`/`writeFile`: round-trip, including nested paths.
 *   - `editFile`: the layered-matching transform (fuzzy indent-adjusted +
 *     range mode) applied atomically.
 *   - mounts: capability-tiered — feature-detected; when supported, an
 *     add/list/remove round-trip; when not, the methods are absent.
 *   - `destroy`: releases the instance (subsequent ops reject).
 *
 * Provider-agnostic: it drives only the `SandboxHandle` surface. It ships
 * from `@agentick/sandbox/testing` — the double + conformance live
 * WITH the contract they pin (ADR 59), so every provider deps the base
 * and imports this suite from one place.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SandboxUnsupportedError } from "../errors.js";
import type { SandboxHandle, SandboxProvider } from "../contract.js";

export interface SandboxProviderConformanceOptions {
  /** Suite label (defaults to the provider `name`). */
  readonly label?: string;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a
   * provider). For providers whose backend may be absent in the test env
   * — e.g. `@agentick/sandbox-docker` gating on a `docker info` probe — compute
   * the availability boolean at the call site and pass `skip: !available`.
   * Threading it as an option (rather than wrapping the call in an `if`)
   * keeps the gate out of the test-body conditionals the linter forbids.
   */
  readonly skip?: boolean;
}

/**
 * Run the provider conformance suite. `makeProvider` is called once per
 * test to obtain a fresh provider; every handle the test creates is
 * destroyed on teardown.
 *
 * @example
 * ```ts
 * describe("local provider", () => {
 *   runSandboxProviderConformance(() => localProvider());
 * });
 * ```
 */
export function runSandboxProviderConformance(
  makeProvider: () => SandboxProvider | Promise<SandboxProvider>,
  options: SandboxProviderConformanceOptions = {},
): void {
  const label = options.label;
  const suite = options.skip ? describe.skip : describe;

  suite(`SandboxProvider conformance${label ? ` — ${label}` : ""}`, () => {
    const live: SandboxHandle[] = [];
    const hostDirs: string[] = [];

    async function create(): Promise<SandboxHandle> {
      const provider = await makeProvider();
      const handle = await provider.create({ workspace: true });
      live.push(handle);
      return handle;
    }

    afterEach(async () => {
      await Promise.all(live.map((h) => h.destroy().catch(() => {})));
      live.length = 0;
      await Promise.all(hostDirs.map((d) => rm(d, { recursive: true, force: true })));
      hostDirs.length = 0;
    });

    // ─── exec ───

    it("exec returns stdout/stderr/exitCode", async () => {
      const sb = await create();
      const ok = await sb.exec("echo hello");
      expect(ok.stdout.trim()).toBe("hello");
      expect(ok.exitCode).toBe(0);

      const fail = await sb.exec("echo oops >&2; exit 3");
      expect(fail.stderr.trim()).toBe("oops");
      expect(fail.exitCode).toBe(3);
    });

    it("exec streams live output through onOutput", async () => {
      const sb = await create();
      const chunks: string[] = [];
      const result = await sb.exec("echo streamed", {
        onOutput: (c) => {
          if (c.stream === "stdout") chunks.push(c.chunk);
        },
      });
      expect(chunks.join("")).toContain("streamed");
      // stdout on the result stays authoritative regardless of streaming.
      expect(result.stdout).toContain("streamed");
    });

    it("exec honors cwd + env", async () => {
      const sb = await create();
      const cwd = await sb.exec("pwd");
      expect(cwd.stdout.trim()).toBe(sb.workspacePath);
      const env = await sb.exec("echo $MY_VAR", { env: { MY_VAR: "custom" } });
      expect(env.stdout.trim()).toBe("custom");
    });

    // ─── readFile / writeFile ───

    it("writeFile → readFile round-trips, including nested paths", async () => {
      const sb = await create();
      await sb.writeFile("dir/nested/file.txt", "content-A");
      expect(await sb.readFile("dir/nested/file.txt")).toBe("content-A");
      await sb.writeFile("dir/nested/file.txt", "content-B");
      expect(await sb.readFile("dir/nested/file.txt")).toBe("content-B");
    });

    // ─── editFile ───

    it("editFile applies a fuzzy (indent-adjusted) edit atomically", async () => {
      const sb = await create();
      // File is 2-space indented; the anchor is supplied WITHOUT indent,
      // so only the indent-adjusted matching strategy can find it.
      await sb.writeFile("code.ts", "  const x = 1;\n  const y = 2;\n");
      const result = await sb.editFile("code.ts", [
        { old: "const x = 1;\nconst y = 2;", new: "const z = 3;" },
      ]);
      expect(result.applied).toBe(1);
      // Written back atomically — a fresh read reflects the edit.
      expect(await sb.readFile("code.ts")).toBe("  const z = 3;\n");
    });

    it("editFile applies a range edit between markers", async () => {
      const sb = await create();
      await sb.writeFile("range.txt", "keep\nSTART\ndrop me\ndrop me too\nEND\nkeep\n");
      const result = await sb.editFile("range.txt", [
        { from: "START", to: "END", content: "REPLACED" },
      ]);
      expect(result.applied).toBe(1);
      expect(await sb.readFile("range.txt")).toBe("keep\nREPLACED\nkeep\n");
    });

    // ─── mounts (capability-tiered) ───

    it("mounts: add/list/remove round-trip when supported, else capability-tiered", async () => {
      const sb = await create();

      if (!sb.addMount || !sb.listMounts || !sb.removeMount) {
        // Capability-tier, honest answer #1: a provider that can't remount
        // a running instance leaves these undefined.
        expect(sb.addMount).toBeUndefined();
        return;
      }

      const hostDir = await mkdtemp(join(tmpdir(), "sbx-mount-"));
      hostDirs.push(hostDir);
      await writeFile(join(hostDir, "host.txt"), "from-host");

      // Capability-tier, honest answer #2 (e.g. docker): the methods exist
      // but throw SandboxUnsupportedError rather than faking success. Both
      // answers are contract-valid (ADR 59); NEVER a silent no-op.
      try {
        await sb.addMount({ hostPath: hostDir, sandboxPath: "mnt" });
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxUnsupportedError);
        await expect(sb.listMounts()).rejects.toBeInstanceOf(SandboxUnsupportedError);
        await expect(sb.removeMount("mnt")).rejects.toBeInstanceOf(SandboxUnsupportedError);
        return;
      }

      const mounts = await sb.listMounts();
      expect(mounts.some((m) => m.sandboxPath === "mnt")).toBe(true);

      // The mounted host file is now reachable through the sandbox path.
      expect(await sb.readFile("mnt/host.txt")).toBe("from-host");

      await sb.removeMount("mnt");
      expect((await sb.listMounts()).some((m) => m.sandboxPath === "mnt")).toBe(false);
    });

    // ─── destroy ───

    it("destroy releases the instance; subsequent ops reject", async () => {
      const provider = await makeProvider();
      const sb = await provider.create({ workspace: true });
      await sb.destroy();
      await expect(sb.readFile("anything.txt")).rejects.toBeDefined();
    });
  });
}
