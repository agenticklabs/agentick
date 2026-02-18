import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Scheduler } from "../scheduler.js";
import type { Job } from "../types.js";

function createMockStore(jobs: Job[] = []) {
  const store = new EventEmitter() as EventEmitter & {
    listEnabled(): Job[];
    get(id: string): Job | null;
    update(id: string, updates: Partial<Job>): Job | null;
    _jobs: Map<string, Job>;
  };
  store._jobs = new Map(jobs.map((j) => [j.id, j]));
  store.listEnabled = () => [...store._jobs.values()].filter((j) => j.enabled);
  store.get = (id: string) => store._jobs.get(id) ?? null;
  store.update = (id: string, updates: Partial<Job>) => {
    const job = store._jobs.get(id);
    if (!job) return null;
    Object.assign(job, updates);
    return job;
  };
  return store;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test-job",
    name: "Test Job",
    cron: "* * * * *",
    target: "tui",
    prompt: "Hello",
    oneshot: false,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Scheduler", () => {
  let triggersDir: string;

  beforeEach(() => {
    triggersDir = mkdtempSync(join(tmpdir(), "scheduler-triggers-"));
  });

  afterEach(() => {
    rmSync(triggersDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Timer management
  // =========================================================================

  it("starts and stops without errors", () => {
    const store = createMockStore([makeJob()]);
    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();
    scheduler.stop();
  });

  it("creates timers for enabled jobs on start", () => {
    const store = createMockStore([
      makeJob({ id: "a", enabled: true }),
      makeJob({ id: "b", enabled: false }),
      makeJob({ id: "c", enabled: true }),
    ]);

    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();

    // Access internal timers map
    const timers = (scheduler as any).timers as Map<string, unknown>;
    expect(timers.size).toBe(2);
    expect(timers.has("a")).toBe(true);
    expect(timers.has("b")).toBe(false);
    expect(timers.has("c")).toBe(true);

    scheduler.stop();
    expect(timers.size).toBe(0);
  });

  it("re-syncs timers on store change event", () => {
    const store = createMockStore([makeJob({ id: "a" })]);
    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();

    const timers = (scheduler as any).timers as Map<string, unknown>;
    expect(timers.size).toBe(1);

    // Add a new job and emit change
    store._jobs.set("b", makeJob({ id: "b" }));
    store.emit("change");

    expect(timers.size).toBe(2);

    // Remove a job and emit change
    store._jobs.delete("a");
    store.emit("change");

    expect(timers.size).toBe(1);
    expect(timers.has("b")).toBe(true);

    scheduler.stop();
  });

  // =========================================================================
  // Heartbeat pre-filter
  // =========================================================================

  it("skips trigger when heartbeat file does not exist", () => {
    const job = makeJob({
      id: "heartbeat",
      metadata: { heartbeatFile: join(triggersDir, "nonexistent.md") },
    });
    const store = createMockStore([job]);

    const scheduler = new Scheduler(store as any, triggersDir);

    // Call _writeTrigger directly
    (scheduler as any)._writeTrigger(job);

    // No trigger file should be written
    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(0);
  });

  it("skips trigger when heartbeat file is empty", () => {
    const heartbeatPath = join(triggersDir, "HEARTBEAT.md");
    writeFileSync(heartbeatPath, "");

    const job = makeJob({
      id: "heartbeat",
      metadata: { heartbeatFile: heartbeatPath },
    });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);

    (scheduler as any)._writeTrigger(job);

    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(0);
  });

  it("includes heartbeat file contents in trigger prompt", () => {
    const heartbeatPath = join(triggersDir, "HEARTBEAT.md");
    writeFileSync(heartbeatPath, "## Priority\n- Fix the bug\n- Deploy");

    const job = makeJob({
      id: "heartbeat",
      prompt: "[heartbeat] Act on your work.",
      metadata: { heartbeatFile: heartbeatPath },
    });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);

    (scheduler as any)._writeTrigger(job);

    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);

    const raw = readFileSync(join(triggersDir, files[0]), "utf-8");
    const trigger = JSON.parse(raw);
    expect(trigger.prompt).toContain("[heartbeat] Act on your work.");
    expect(trigger.prompt).toContain("## Priority");
    expect(trigger.prompt).toContain("- Fix the bug");
  });

  it("writes trigger for non-heartbeat job (no metadata.heartbeatFile)", () => {
    const job = makeJob({ id: "regular" });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);

    (scheduler as any)._writeTrigger(job);

    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("updates lastFiredAt when trigger is written", () => {
    const job = makeJob({ id: "fireable" });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);

    expect(job.lastFiredAt).toBeUndefined();
    (scheduler as any)._writeTrigger(job);
    expect(job.lastFiredAt).toBeTruthy();
  });

  // =========================================================================
  // Adversarial: cron expression changes
  // =========================================================================

  it("recreates timer when cron expression changes", () => {
    const job = makeJob({ id: "evolving", cron: "* * * * *" });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();

    const timers = (scheduler as any).timers as Map<string, { task: unknown; cronExpr: string }>;
    expect(timers.get("evolving")?.cronExpr).toBe("* * * * *");

    // Change the cron expression and emit change
    job.cron = "0 * * * *";
    store.emit("change");

    expect(timers.get("evolving")?.cronExpr).toBe("0 * * * *");
    scheduler.stop();
  });

  it("does NOT recreate timer when expression is unchanged", () => {
    const job = makeJob({ id: "stable", cron: "* * * * *" });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();

    const timers = (scheduler as any).timers as Map<string, { task: unknown; cronExpr: string }>;
    const firstEntry = timers.get("stable");

    // Emit change without modifying cron
    store.emit("change");

    // Same entry object — timer was NOT recreated
    expect(timers.get("stable")).toBe(firstEntry);
    scheduler.stop();
  });

  it("reads fresh job state from store on trigger fire", () => {
    const job = makeJob({ id: "mutable", prompt: "original prompt" });
    const store = createMockStore([job]);
    const scheduler = new Scheduler(store as any, triggersDir);

    // Update prompt AFTER scheduling
    job.prompt = "updated prompt";

    // Fire trigger manually — should read fresh state from store
    (scheduler as any)._writeTrigger(store.get("mutable")!);

    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const trigger = JSON.parse(readFileSync(join(triggersDir, files[0]), "utf-8"));
    expect(trigger.prompt).toBe("updated prompt");
  });

  // =========================================================================
  // Adversarial: invalid cron expressions
  // =========================================================================

  it("silently skips jobs with invalid cron expressions", () => {
    const store = createMockStore([
      makeJob({ id: "bad-cron", cron: "not a cron" }),
      makeJob({ id: "good-cron", cron: "* * * * *" }),
    ]);

    const scheduler = new Scheduler(store as any, triggersDir);
    scheduler.start();

    const timers = (scheduler as any).timers as Map<string, unknown>;
    // Only the valid cron job gets a timer
    expect(timers.has("good-cron")).toBe(true);
    expect(timers.has("bad-cron")).toBe(false);

    scheduler.stop();
  });

  // =========================================================================
  // Adversarial: stop cleans up listeners
  // =========================================================================

  it("unsubscribes from store change events on stop", () => {
    const store = createMockStore([makeJob()]);
    const scheduler = new Scheduler(store as any, triggersDir);

    scheduler.start();
    expect(store.listenerCount("change")).toBe(1);

    scheduler.stop();
    expect(store.listenerCount("change")).toBe(0);
  });
});
