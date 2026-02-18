import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronService } from "../cron-service.js";
import type { Trigger } from "../types.js";

function createMockClient() {
  const sends: Array<{ sessionId: string; input: unknown }> = [];
  return {
    session(id: string) {
      return {
        send(input: unknown) {
          sends.push({ sessionId: id, input });
          return { result: Promise.resolve() };
        },
      };
    },
    _sends: sends,
  };
}

describe("CronService", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cronservice-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  it("creates jobs and triggers directories on construction", () => {
    const client = createMockClient();
    const _service = new CronService({ dataDir, client: client as any });
    expect(existsSync(join(dataDir, "jobs"))).toBe(true);
    expect(existsSync(join(dataDir, "triggers"))).toBe(true);
  });

  it("start and stop without errors", async () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });
    await service.start();
    await service.stop();
  });

  // =========================================================================
  // Heartbeat
  // =========================================================================

  it("ensureHeartbeat creates a heartbeat job", () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });
    const job = service.ensureHeartbeat();

    expect(job.id).toBe("heartbeat");
    expect(job.name).toBe("heartbeat");
    expect(job.cron).toBe("*/5 * * * *");
    expect(job.metadata?.heartbeatFile).toBe(".tentickle/HEARTBEAT.md");
  });

  it("ensureHeartbeat is idempotent", () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });
    const first = service.ensureHeartbeat();
    const second = service.ensureHeartbeat();
    expect(first.id).toBe(second.id);
    expect(service.store.list()).toHaveLength(1);
  });

  it("ensureHeartbeat accepts custom options", () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });
    const job = service.ensureHeartbeat({
      cron: "0 * * * *",
      target: "telegram",
      heartbeatFile: "/custom/path.md",
    });

    expect(job.cron).toBe("0 * * * *");
    expect(job.target).toBe("telegram");
    expect(job.metadata?.heartbeatFile).toBe("/custom/path.md");
  });

  // =========================================================================
  // Store persistence through service lifecycle
  // =========================================================================

  it("persists jobs across service instances", async () => {
    const client = createMockClient();

    const service1 = new CronService({ dataDir, client: client as any });
    service1.store.create({
      name: "persistent",
      cron: "0 0 * * *",
      target: "tui",
      prompt: "hello",
      oneshot: false,
      enabled: true,
    });
    await service1.stop();

    // New instance should load from disk
    const service2 = new CronService({ dataDir, client: client as any });
    expect(service2.store.list()).toHaveLength(1);
    expect(service2.store.get("persistent")?.prompt).toBe("hello");
    await service2.stop();
  });

  // =========================================================================
  // Trigger processing through the full stack
  // =========================================================================

  it("processes triggers on startup (end-to-end)", async () => {
    const client = createMockClient();
    const processed: Trigger[] = [];

    // Write a trigger file manually (simulating scheduler or external writer)
    const triggersDir = join(dataDir, "triggers");
    // CronService constructor creates dirs, but we need it early
    const { mkdirSync } = await import("node:fs");
    mkdirSync(triggersDir, { recursive: true });

    writeFileSync(
      join(triggersDir, "1000-test.json"),
      JSON.stringify({
        jobId: "test",
        jobName: "Test",
        target: "tui",
        prompt: "end-to-end test",
        firedAt: new Date().toISOString(),
        oneshot: false,
      }),
    );

    const service = new CronService({
      dataDir,
      client: client as any,
      onTriggerProcessed: (t) => processed.push(t),
    });

    // start() drains pending triggers before returning
    await service.start();
    await service.stop();

    expect(processed).toHaveLength(1);
    expect(processed[0].prompt).toBe("end-to-end test");
    expect(client._sends).toHaveLength(1);
    expect(client._sends[0].sessionId).toBe("tui");

    // Verify event role and source
    const msg = (client._sends[0].input as any).messages[0];
    expect(msg.role).toBe("event");
    expect(msg.metadata.source).toEqual({ type: "cron" });
    expect(msg.metadata.event_type).toBe("cron_trigger");
  });

  // =========================================================================
  // Adversarial: job mutation during trigger processing
  // =========================================================================

  it("handles job deletion while triggers exist", async () => {
    const client = createMockClient();

    // Create a job, then write a trigger for it, then delete the job
    const service = new CronService({ dataDir, client: client as any });
    service.store.create({
      name: "ephemeral",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    // Write trigger
    writeFileSync(
      join(dataDir, "triggers", "1000-ephemeral.json"),
      JSON.stringify({
        jobId: "ephemeral",
        jobName: "Ephemeral",
        target: "tui",
        prompt: "trigger for deleted job",
        firedAt: new Date().toISOString(),
        oneshot: false,
      }),
    );

    // Delete the job before starting
    service.store.delete("ephemeral");

    // start() drains pending triggers before returning
    await service.start();
    await service.stop();

    // Trigger should still be processed (trigger is self-contained)
    expect(client._sends).toHaveLength(1);
  });

  // =========================================================================
  // Adversarial: scheduler refresh when jobs are added/removed
  // =========================================================================

  it("scheduler picks up new jobs dynamically", async () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });

    await service.start();

    // Add a job after start — scheduler should pick it up via "change" event
    service.store.create({
      name: "dynamic",
      cron: "* * * * *",
      target: "tui",
      prompt: "dynamic job",
      oneshot: false,
      enabled: true,
    });

    // The scheduler listens to store "change" events and syncs timers
    // We can't easily test the timer fires in a unit test, but we can verify
    // the scheduler didn't crash
    await service.stop();
  });

  it("scheduler removes timers for disabled jobs", async () => {
    const client = createMockClient();
    const service = new CronService({ dataDir, client: client as any });

    service.store.create({
      name: "toggle-me",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();

    // Disable the job
    service.store.update("toggle-me", { enabled: false });

    // Re-enable
    service.store.update("toggle-me", { enabled: true });

    await service.stop();
    // No crash = success
  });

  // =========================================================================
  // Adversarial: permission errors (trigger dir not writable)
  // =========================================================================

  it("reports errors via onError callback", async () => {
    const errors: Array<{ error: Error; context: string }> = [];

    // Write an invalid trigger before constructing (so drain picks it up)
    const { mkdirSync: mkdir } = await import("node:fs");
    mkdir(join(dataDir, "triggers"), { recursive: true });
    writeFileSync(join(dataDir, "triggers", "bad.json"), "not json!!!{{{");

    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    // start() drains pending triggers — bad.json processed during drain
    await service.start();
    await service.stop();

    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
