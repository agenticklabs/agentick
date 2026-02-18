import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronService } from "../cron-service.js";
import type { Trigger, SchedulerBackend, Job } from "../types.js";

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

function createMockBackend(): SchedulerBackend & {
  _scheduled: Map<string, { job: Job; onFire: () => Promise<void> }>;
  _started: boolean;
  _stopped: boolean;
  fireJob(jobId: string): Promise<void>;
} {
  const scheduled = new Map<string, { job: Job; onFire: () => Promise<void> }>();
  let started = false;
  let stopped = false;

  return {
    _scheduled: scheduled,
    get _started() {
      return started;
    },
    get _stopped() {
      return stopped;
    },

    async start() {
      started = true;
    },
    async stop() {
      stopped = true;
      scheduled.clear();
    },
    schedule(job: Job, onFire: () => Promise<void>) {
      scheduled.set(job.id, { job, onFire });
    },
    unschedule(jobId: string) {
      scheduled.delete(jobId);
    },

    // Test helper: simulate a job firing
    async fireJob(jobId: string) {
      const entry = scheduled.get(jobId);
      if (!entry) throw new Error(`No scheduled job: ${jobId}`);
      await entry.onFire();
    },
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

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  it("creates jobs directory on construction", () => {
    const client = createMockClient();
    const _service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    expect(existsSync(join(dataDir, "jobs"))).toBe(true);
  });

  it("start and stop without errors", async () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    await service.start();
    await service.stop();
  });

  it("accepts a custom backend", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    await service.start();
    expect(backend._started).toBe(true);
    await service.stop();
    expect(backend._stopped).toBe(true);
  });

  it("defaults to NodeCronBackend when no backend provided", () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    // Backend should exist and not be null
    expect(service.backend).toBeDefined();
    expect(service.backend.start).toBeTypeOf("function");
  });

  // ===========================================================================
  // Backend wiring: schedule enabled jobs on start
  // ===========================================================================

  it("schedules enabled jobs with backend on start", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "enabled-job",
      cron: "* * * * *",
      target: "tui",
      prompt: "hello",
      oneshot: false,
      enabled: true,
    });
    service.store.create({
      name: "disabled-job",
      cron: "* * * * *",
      target: "tui",
      prompt: "skip me",
      oneshot: false,
      enabled: false,
    });

    await service.start();

    expect(backend._scheduled.size).toBe(1);
    expect(backend._scheduled.has("enabled-job")).toBe(true);
    expect(backend._scheduled.has("disabled-job")).toBe(false);

    await service.stop();
  });

  // ===========================================================================
  // Backend wiring: re-sync on store changes
  // ===========================================================================

  it("re-syncs backend when jobs are added", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    await service.start();
    expect(backend._scheduled.size).toBe(0);

    service.store.create({
      name: "dynamic",
      cron: "* * * * *",
      target: "tui",
      prompt: "added after start",
      oneshot: false,
      enabled: true,
    });

    expect(backend._scheduled.size).toBe(1);
    expect(backend._scheduled.has("dynamic")).toBe(true);

    await service.stop();
  });

  it("re-syncs backend when jobs are disabled", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "toggle-me",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    expect(backend._scheduled.has("toggle-me")).toBe(true);

    service.store.update("toggle-me", { enabled: false });
    expect(backend._scheduled.has("toggle-me")).toBe(false);

    service.store.update("toggle-me", { enabled: true });
    expect(backend._scheduled.has("toggle-me")).toBe(true);

    await service.stop();
  });

  it("re-syncs backend when jobs are deleted", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "doomed",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    expect(backend._scheduled.has("doomed")).toBe(true);

    service.store.delete("doomed");
    expect(backend._scheduled.has("doomed")).toBe(false);

    await service.stop();
  });

  // ===========================================================================
  // Dispatch: backend fires → client.session().send()
  // ===========================================================================

  it("dispatches to client when backend fires", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "fireable",
      cron: "* * * * *",
      target: "tui",
      prompt: "fire me",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    await backend.fireJob("fireable");

    expect(client._sends).toHaveLength(1);
    expect(client._sends[0].sessionId).toBe("tui");
    const msg = (client._sends[0].input as any).messages[0];
    expect(msg.role).toBe("event");
    expect(msg.metadata.source).toEqual({ type: "cron" });
    expect(msg.metadata.event_type).toBe("cron_trigger");

    await service.stop();
  });

  it("reads fresh job state on dispatch", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "mutable",
      cron: "* * * * *",
      target: "tui",
      prompt: "original",
      oneshot: false,
      enabled: true,
    });

    await service.start();

    // Update prompt AFTER scheduling
    service.store.update("mutable", { prompt: "updated" });

    await backend.fireJob("mutable");

    const msg = (client._sends[0].input as any).messages[0];
    expect(msg.content[0].text).toBe("updated");

    await service.stop();
  });

  it("updates lastFiredAt after dispatch", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "track-fire",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    expect(service.store.get("track-fire")!.lastFiredAt).toBeUndefined();

    await backend.fireJob("track-fire");
    expect(service.store.get("track-fire")!.lastFiredAt).toBeTruthy();

    await service.stop();
  });

  it("deletes oneshot jobs after dispatch", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "once",
      cron: "* * * * *",
      target: "tui",
      prompt: "one time only",
      oneshot: true,
      enabled: true,
    });

    await service.start();
    expect(service.store.get("once")).toBeTruthy();

    await backend.fireJob("once");
    expect(service.store.get("once")).toBeNull();

    await service.stop();
  });

  it("calls onTriggerProcessed after dispatch", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const processed: Trigger[] = [];
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
      onTriggerProcessed: (t) => processed.push(t),
    });

    service.store.create({
      name: "notify",
      cron: "* * * * *",
      target: "tui",
      prompt: "notified",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    await backend.fireJob("notify");

    expect(processed).toHaveLength(1);
    expect(processed[0].prompt).toBe("notified");

    await service.stop();
  });

  it("uses defaultTarget when job has no target", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      defaultTarget: "fallback",
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "no-target",
      cron: "* * * * *",
      target: "",
      prompt: "where do I go",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    await backend.fireJob("no-target");

    expect(client._sends[0].sessionId).toBe("fallback");
    await service.stop();
  });

  // ===========================================================================
  // Adversarial: dispatch edge cases
  // ===========================================================================

  it("skips dispatch if job was deleted between schedule and fire", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "vanishing",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();

    // Capture the onFire callback before deletion
    const entry = backend._scheduled.get("vanishing")!;

    // Delete the job — this triggers re-sync which unschedules
    service.store.delete("vanishing");

    // But call the old callback anyway (simulates race)
    await entry.onFire();

    // Should not have dispatched
    expect(client._sends).toHaveLength(0);
    await service.stop();
  });

  it("skips dispatch if job was disabled between schedule and fire", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
    });

    service.store.create({
      name: "disabling",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    const entry = backend._scheduled.get("disabling")!;

    service.store.update("disabling", { enabled: false });
    await entry.onFire();

    expect(client._sends).toHaveLength(0);
    await service.stop();
  });

  it("reports errors via onError when dispatch fails", async () => {
    const errors: Array<{ error: Error; context: string }> = [];
    const failingClient = {
      session() {
        return {
          send() {
            return { result: Promise.reject(new Error("send failed")) };
          },
        };
      },
    };
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: failingClient as any,
      backend,
      watchExternalTriggers: false,
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    service.store.create({
      name: "failing",
      cron: "* * * * *",
      target: "tui",
      prompt: "p",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    await backend.fireJob("failing");

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe("send failed");
    expect(errors[0].context).toBe("dispatch:failing");

    await service.stop();
  });

  it("reports error when no target and no defaultTarget", async () => {
    const errors: Array<{ error: Error; context: string }> = [];
    const client = createMockClient();
    const backend = createMockBackend();
    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: false,
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    service.store.create({
      name: "homeless",
      cron: "* * * * *",
      target: "",
      prompt: "nowhere to go",
      oneshot: false,
      enabled: true,
    });

    await service.start();
    await backend.fireJob("homeless");

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("no target");
    expect(client._sends).toHaveLength(0);

    await service.stop();
  });

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  it("ensureHeartbeat creates a heartbeat job", () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    const job = service.ensureHeartbeat();

    expect(job.id).toBe("heartbeat");
    expect(job.name).toBe("heartbeat");
    expect(job.cron).toBe("*/5 * * * *");
    expect(job.metadata?.heartbeatFile).toBe(".tentickle/HEARTBEAT.md");
  });

  it("ensureHeartbeat is idempotent", () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    const first = service.ensureHeartbeat();
    const second = service.ensureHeartbeat();
    expect(first.id).toBe(second.id);
    expect(service.store.list()).toHaveLength(1);
  });

  it("ensureHeartbeat accepts custom options", () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    const job = service.ensureHeartbeat({
      cron: "0 * * * *",
      target: "telegram",
      heartbeatFile: "/custom/path.md",
    });

    expect(job.cron).toBe("0 * * * *");
    expect(job.target).toBe("telegram");
    expect(job.metadata?.heartbeatFile).toBe("/custom/path.md");
  });

  // ===========================================================================
  // Store persistence through service lifecycle
  // ===========================================================================

  it("persists jobs across service instances", async () => {
    const client = createMockClient();

    const service1 = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    service1.store.create({
      name: "persistent",
      cron: "0 0 * * *",
      target: "tui",
      prompt: "hello",
      oneshot: false,
      enabled: true,
    });
    await service1.stop();

    const service2 = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    expect(service2.store.list()).toHaveLength(1);
    expect(service2.store.get("persistent")?.prompt).toBe("hello");
    await service2.stop();
  });

  // ===========================================================================
  // External trigger watcher
  // ===========================================================================

  it("processes external trigger files on startup when watcher enabled", async () => {
    const client = createMockClient();
    const backend = createMockBackend();
    const processed: Trigger[] = [];

    // Pre-create triggers dir and write a trigger
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dataDir, "triggers"), { recursive: true });
    writeFileSync(
      join(dataDir, "triggers", "1000-test.json"),
      JSON.stringify({
        jobId: "test",
        jobName: "Test",
        target: "tui",
        prompt: "external trigger",
        firedAt: new Date().toISOString(),
        oneshot: false,
      }),
    );

    const service = new CronService({
      dataDir,
      client: client as any,
      backend,
      watchExternalTriggers: true,
      onTriggerProcessed: (t) => processed.push(t),
    });

    await service.start();
    await service.stop();

    // External watcher should have processed the trigger
    expect(processed).toHaveLength(1);
    expect(processed[0].prompt).toBe("external trigger");
  });

  it("disables watcher when watchExternalTriggers is false", () => {
    const client = createMockClient();
    const service = new CronService({
      dataDir,
      client: client as any,
      watchExternalTriggers: false,
    });
    expect(service.watcher).toBeNull();
  });
});
