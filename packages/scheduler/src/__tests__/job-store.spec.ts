import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../job-store.js";

describe("JobStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jobstore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  it("creates a job and persists to disk", () => {
    const store = new JobStore(dir);
    const job = store.create({
      name: "test-job",
      cron: "* * * * *",
      target: "tui",
      prompt: "Hello",
      oneshot: false,
      enabled: true,
    });

    expect(job.id).toBe("test-job");
    expect(job.createdAt).toBeTruthy();

    // Verify file written
    const files = readdirSync(dir);
    expect(files).toContain("test-job.json");

    // Verify file content matches
    const raw = readFileSync(join(dir, "test-job.json"), "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.id).toBe("test-job");
    expect(persisted.prompt).toBe("Hello");
  });

  it("loads jobs from disk on construction", () => {
    // Write a job file before creating the store
    writeFileSync(
      join(dir, "pre-existing.json"),
      JSON.stringify({
        id: "pre-existing",
        name: "Pre-existing",
        cron: "0 0 * * *",
        target: "telegram",
        prompt: "Wake up",
        oneshot: false,
        enabled: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    const store = new JobStore(dir);
    expect(store.list()).toHaveLength(1);
    expect(store.get("pre-existing")?.name).toBe("Pre-existing");
  });

  it("lists only enabled jobs", () => {
    const store = new JobStore(dir);
    store.create({
      name: "a",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    store.create({
      name: "b",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: false,
    });
    store.create({
      name: "c",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    expect(store.listEnabled()).toHaveLength(2);
    expect(store.listEnabled().map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("updates a job and persists change", () => {
    const store = new JobStore(dir);
    store.create({
      name: "updatable",
      cron: "* * * * *",
      target: "t",
      prompt: "old",
      oneshot: false,
      enabled: true,
    });

    const updated = store.update("updatable", { prompt: "new", enabled: false });
    expect(updated?.prompt).toBe("new");
    expect(updated?.enabled).toBe(false);

    // Verify persisted
    const raw = readFileSync(join(dir, "updatable.json"), "utf-8");
    expect(JSON.parse(raw).prompt).toBe("new");
  });

  it("deletes a job and removes file", () => {
    const store = new JobStore(dir);
    store.create({
      name: "deletable",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    expect(store.delete("deletable")).toBe(true);
    expect(store.get("deletable")).toBeNull();
    expect(readdirSync(dir)).not.toContain("deletable.json");
  });

  it("emits change on create, update, delete", () => {
    const store = new JobStore(dir);
    const changes: string[] = [];
    store.on("change", () => changes.push("change"));

    store.create({
      name: "x",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    store.update("x", { prompt: "updated" });
    store.delete("x");

    expect(changes).toEqual(["change", "change", "change"]);
  });

  // =========================================================================
  // ID generation — collision handling
  // =========================================================================

  it("generates slugified IDs from name", () => {
    const store = new JobStore(dir);
    const job = store.create({
      name: "Remind User About Meeting!",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    expect(job.id).toBe("remind-user-about-meeting");
  });

  it("appends suffix on ID collision", () => {
    const store = new JobStore(dir);
    store.create({
      name: "dupe",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    const second = store.create({
      name: "dupe",
      cron: "* * * * *",
      target: "t",
      prompt: "p2",
      oneshot: false,
      enabled: true,
    });
    expect(second.id).toBe("dupe-2");
  });

  it("uses explicit id when provided", () => {
    const store = new JobStore(dir);
    const job = store.create({
      id: "custom-id",
      name: "Whatever Name",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    expect(job.id).toBe("custom-id");
  });

  it("throws on explicit id collision", () => {
    const store = new JobStore(dir);
    store.create({
      id: "taken",
      name: "a",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    expect(() =>
      store.create({
        id: "taken",
        name: "b",
        cron: "* * * * *",
        target: "t",
        prompt: "p",
        oneshot: false,
        enabled: true,
      }),
    ).toThrow('Job "taken" already exists');
  });

  // =========================================================================
  // Adversarial: malformed files
  // =========================================================================

  it("ignores non-json files in jobs dir", () => {
    writeFileSync(join(dir, "readme.txt"), "not a job");
    writeFileSync(join(dir, ".DS_Store"), "");
    const store = new JobStore(dir);
    expect(store.list()).toHaveLength(0);
  });

  it("skips malformed JSON files without crashing", () => {
    writeFileSync(join(dir, "bad.json"), "{ invalid json }}}}");
    writeFileSync(
      join(dir, "good.json"),
      JSON.stringify({
        id: "good",
        name: "Good",
        cron: "* * * * *",
        target: "t",
        prompt: "p",
        oneshot: false,
        enabled: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    const store = new JobStore(dir);
    expect(store.list()).toHaveLength(1);
    expect(store.get("good")).toBeTruthy();
  });

  it("skips JSON files with no id field", () => {
    writeFileSync(join(dir, "no-id.json"), JSON.stringify({ name: "orphan" }));
    const store = new JobStore(dir);
    expect(store.list()).toHaveLength(0);
  });

  // =========================================================================
  // Adversarial: update/delete nonexistent
  // =========================================================================

  it("returns null when updating nonexistent job", () => {
    const store = new JobStore(dir);
    expect(store.update("ghost", { prompt: "boo" })).toBeNull();
  });

  it("returns false when deleting nonexistent job", () => {
    const store = new JobStore(dir);
    expect(store.delete("ghost")).toBe(false);
  });

  it("does not emit change when delete fails", () => {
    const store = new JobStore(dir);
    const changes: number[] = [];
    store.on("change", () => changes.push(1));
    store.delete("nonexistent");
    expect(changes).toHaveLength(0);
  });

  // =========================================================================
  // Adversarial: concurrent creates with same name
  // =========================================================================

  it("handles rapid sequential creates with same name", () => {
    const store = new JobStore(dir);
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const job = store.create({
        name: "same-name",
        cron: "* * * * *",
        target: "t",
        prompt: `prompt-${i}`,
        oneshot: false,
        enabled: true,
      });
      ids.add(job.id);
    }
    // All IDs must be unique
    expect(ids.size).toBe(10);
    expect(store.list()).toHaveLength(10);
  });

  // =========================================================================
  // Adversarial: store survives across instances (persistence round-trip)
  // =========================================================================

  it("survives store recreation (crash recovery)", () => {
    const store1 = new JobStore(dir);
    store1.create({
      name: "survivor",
      cron: "0 0 * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    store1.create({
      name: "also-survivor",
      cron: "0 12 * * *",
      target: "t",
      prompt: "p",
      oneshot: true,
      enabled: false,
    });

    // Simulate crash: new instance loads from disk
    const store2 = new JobStore(dir);
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("survivor")?.enabled).toBe(true);
    expect(store2.get("also-survivor")?.oneshot).toBe(true);
  });

  // =========================================================================
  // Edge: empty name, special chars
  // =========================================================================

  it("generates random id for empty name", () => {
    const store = new JobStore(dir);
    const job = store.create({
      name: "",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    expect(job.id.length).toBeGreaterThan(0);
  });

  it("handles names with only special characters", () => {
    const store = new JobStore(dir);
    const job = store.create({
      name: "!!!???",
      cron: "* * * * *",
      target: "t",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });
    // Slugify strips all specials → fallback to nanoid
    expect(job.id.length).toBeGreaterThan(0);
  });
});
