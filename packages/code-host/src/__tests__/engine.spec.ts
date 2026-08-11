/**
 * The measurement the capability matrix rests on.
 *
 * `enforces` is a promise to the caller, and the only honest basis for it is
 * having watched the engine keep it. bun accepts `--max-old-space-size` and
 * `--smol` and exits 0 on both, which is exactly the shape of a budget that
 * would silently do nothing — so the claim is made here by running a program
 * that should die under a ceiling and seeing whether it does.
 */

import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { detectEngine, hostCapabilities } from "../engine.js";

/** Allocates without pause. Under a heap ceiling that is real, it cannot last. */
const ALLOCATES = `const held = []; for (;;) held.push(new Array(50_000).fill("x"));`;
const WATCH_MS = 3_000;

function bunPath(): string | undefined {
  if (typeof process.versions.bun === "string") return process.execPath;
  const found = spawnSync("which", ["bun"], { encoding: "utf8" });
  const path = found.stdout.trim();
  return path.length > 0 ? path : undefined;
}

/** True if the process was still running when the watch ended. */
function outlives(command: string, args: readonly string[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    let running = true;
    child.on("exit", () => {
      running = false;
    });
    setTimeout(() => {
      const survived = running;
      child.kill("SIGKILL");
      resolve(survived);
    }, ms);
  });
}

describe("what each engine will actually enforce", () => {
  it.runIf(process.versions.bun === undefined)(
    "node kills an allocation loop at its heap ceiling",
    async () => {
      expect(
        await outlives(process.execPath, ["--max-old-space-size=10", "-e", ALLOCATES], WATCH_MS),
      ).toBe(false);
    },
    WATCH_MS * 3,
  );

  it.runIf(bunPath() !== undefined)(
    "bun accepts both heap flags and honors neither — which is why it declares no memoryMb",
    async () => {
      const bun = bunPath()!;
      expect(await outlives(bun, ["--max-old-space-size=10", "-e", ALLOCATES], WATCH_MS)).toBe(
        true,
      );
      expect(await outlives(bun, ["--smol", "-e", ALLOCATES], WATCH_MS)).toBe(true);
    },
    WATCH_MS * 4,
  );

  it("the declared budgets follow the engine's heap flag, never the other way round", () => {
    const engine = detectEngine();
    const { enforces } = hostCapabilities(engine);
    expect(enforces.includes("memoryMb")).toBe(engine.heapLimitFlag !== undefined);
    expect(hostCapabilities({ name: "someday", execPath: "/x" }).enforces).toEqual([
      "timeMs",
      "outputBytes",
    ]);
  });
});
