/** @jsxImportSource react */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../job-store.js";
import { createScheduleTool } from "../schedule-tool.js";

describe("createScheduleTool", () => {
  let dir: string;
  let store: JobStore;
  let ScheduleTool: ReturnType<typeof createScheduleTool>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schedule-tool-"));
    store = new JobStore(dir);
    ScheduleTool = createScheduleTool(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(input: Record<string, unknown>) {
    const handle = ScheduleTool.run.exec(input as any);
    return (await handle.result) as Array<{ type: string; text: string }>;
  }

  // =========================================================================
  // Add action
  // =========================================================================

  it("adds a job with valid input", async () => {
    const result = await run({
      action: "add",
      name: "daily-reminder",
      cron: "0 9 * * *",
      prompt: "Good morning",
      target: "telegram",
    });

    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("Created job:");
    expect(result[0].text).toContain("daily-reminder");

    expect(store.list()).toHaveLength(1);
    expect(store.get("daily-reminder")?.prompt).toBe("Good morning");
  });

  it("defaults target to 'tui' when not specified", async () => {
    await run({ action: "add", name: "no-target", cron: "* * * * *", prompt: "hi" });
    expect(store.get("no-target")?.target).toBe("tui");
  });

  it("defaults oneshot to false", async () => {
    await run({ action: "add", name: "not-oneshot", cron: "* * * * *", prompt: "hi" });
    expect(store.get("not-oneshot")?.oneshot).toBe(false);
  });

  it("creates oneshot job when specified", async () => {
    await run({
      action: "add",
      name: "one-time",
      cron: "0 0 * * *",
      prompt: "once",
      oneshot: true,
    });
    expect(store.get("one-time")?.oneshot).toBe(true);
  });

  it("rejects add with missing name", async () => {
    const result = await run({ action: "add", cron: "* * * * *", prompt: "hi" });
    expect(result[0].text).toContain("Error");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects add with missing cron", async () => {
    const result = await run({ action: "add", name: "no-cron", prompt: "hi" });
    expect(result[0].text).toContain("Error");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects add with missing prompt", async () => {
    const result = await run({ action: "add", name: "no-prompt", cron: "* * * * *" });
    expect(result[0].text).toContain("Error");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects add with invalid cron expression", async () => {
    const result = await run({
      action: "add",
      name: "bad-cron",
      cron: "not-a-cron-expression",
      prompt: "hi",
    });
    expect(result[0].text).toContain("invalid cron");
    expect(store.list()).toHaveLength(0);
  });

  // =========================================================================
  // List action
  // =========================================================================

  it("lists empty when no jobs", async () => {
    const result = await run({ action: "list" });
    expect(result[0].text).toContain("No scheduled jobs");
  });

  it("lists all jobs with status", async () => {
    store.create({
      name: "a",
      cron: "0 * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    store.create({
      name: "b",
      cron: "0 0 * * *",
      target: "telegram",
      prompt: "p",
      oneshot: true,
      enabled: false,
    });

    const result = await run({ action: "list" });
    expect(result[0].text).toContain("a");
    expect(result[0].text).toContain("b");
    expect(result[0].text).toContain("oneshot");
    expect(result[0].text).toContain("disabled");
  });

  // =========================================================================
  // Remove action
  // =========================================================================

  it("removes an existing job", async () => {
    store.create({
      name: "removable",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    const result = await run({ action: "remove", id: "removable" });
    expect(result[0].text).toContain("Removed");
    expect(store.list()).toHaveLength(0);
  });

  it("errors on removing nonexistent job", async () => {
    const result = await run({ action: "remove", id: "ghost" });
    expect(result[0].text).toContain("not found");
  });

  it("errors on remove without id", async () => {
    const result = await run({ action: "remove" });
    expect(result[0].text).toContain("Error");
  });

  // =========================================================================
  // Enable / Disable actions
  // =========================================================================

  it("disables an enabled job", async () => {
    store.create({
      name: "toggle",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    const result = await run({ action: "disable", id: "toggle" });
    expect(result[0].text).toContain("Disabled");
    expect(store.get("toggle")?.enabled).toBe(false);
  });

  it("enables a disabled job", async () => {
    store.create({
      name: "toggle",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: false,
    });
    const result = await run({ action: "enable", id: "toggle" });
    expect(result[0].text).toContain("Enabled");
    expect(store.get("toggle")?.enabled).toBe(true);
  });

  it("errors on enable without id", async () => {
    const result = await run({ action: "enable" });
    expect(result[0].text).toContain("Error");
  });

  it("errors on enable nonexistent job", async () => {
    const result = await run({ action: "enable", id: "ghost" });
    expect(result[0].text).toContain("not found");
  });

  // =========================================================================
  // Adversarial: rapid sequential operations
  // =========================================================================

  it("handles add → disable → enable → remove in sequence", async () => {
    await run({ action: "add", name: "lifecycle", cron: "0 0 * * *", prompt: "p" });
    expect(store.get("lifecycle")?.enabled).toBe(true);

    await run({ action: "disable", id: "lifecycle" });
    expect(store.get("lifecycle")?.enabled).toBe(false);

    await run({ action: "enable", id: "lifecycle" });
    expect(store.get("lifecycle")?.enabled).toBe(true);

    await run({ action: "remove", id: "lifecycle" });
    expect(store.list()).toHaveLength(0);
  });

  it("handles duplicate add names gracefully (store generates unique IDs)", async () => {
    await run({ action: "add", name: "dupe", cron: "* * * * *", prompt: "a" });
    await run({ action: "add", name: "dupe", cron: "* * * * *", prompt: "b" });

    expect(store.list()).toHaveLength(2);
    const ids = store.list().map((j) => j.id);
    expect(new Set(ids).size).toBe(2);
  });
});
