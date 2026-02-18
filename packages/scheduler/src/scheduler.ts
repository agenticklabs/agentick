import cron, { type ScheduledTask } from "node-cron";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Job, Trigger } from "./types.js";
import type { JobStore } from "./job-store.js";

interface ScheduledEntry {
  task: ScheduledTask;
  cronExpr: string;
}

export class Scheduler {
  private timers = new Map<string, ScheduledEntry>();
  private readonly store: JobStore;
  private readonly triggersDir: string;

  constructor(store: JobStore, triggersDir: string) {
    this.store = store;
    this.triggersDir = triggersDir;
    mkdirSync(triggersDir, { recursive: true });
  }

  start(): void {
    this.store.on("change", this._onChange);
    this._syncTimers();
  }

  stop(): void {
    this.store.off("change", this._onChange);
    for (const [id, entry] of this.timers) {
      entry.task.stop();
      this.timers.delete(id);
    }
  }

  private _onChange = (): void => {
    this._syncTimers();
  };

  private _syncTimers(): void {
    const enabled = new Map(this.store.listEnabled().map((j) => [j.id, j]));

    // Remove timers for jobs that are gone or disabled
    for (const [id, entry] of this.timers) {
      if (!enabled.has(id)) {
        entry.task.stop();
        this.timers.delete(id);
      }
    }

    // Add timers for new jobs, recreate if cron expression changed
    for (const [id, job] of enabled) {
      const existing = this.timers.get(id);
      if (existing && existing.cronExpr !== job.cron) {
        existing.task.stop();
        this.timers.delete(id);
      }
      if (!this.timers.has(id)) {
        this._scheduleJob(job);
      }
    }
  }

  private _scheduleJob(job: Job): void {
    if (!cron.validate(job.cron)) {
      return;
    }

    const jobId = job.id;
    const task = cron.schedule(job.cron, () => {
      // Read fresh from store — job fields may have changed since scheduling
      const current = this.store.get(jobId);
      if (current && current.enabled) {
        this._writeTrigger(current);
      }
    });

    this.timers.set(job.id, { task, cronExpr: job.cron });
  }

  private _writeTrigger(job: Job): void {
    // For heartbeat jobs, read the heartbeat file and include contents
    let prompt = job.prompt;
    const heartbeatFile = job.metadata?.heartbeatFile as string | undefined;
    if (heartbeatFile) {
      try {
        if (!existsSync(heartbeatFile)) return; // Skip: no heartbeat file
        const contents = readFileSync(heartbeatFile, "utf-8").trim();
        if (!contents) return; // Skip: empty heartbeat file
        prompt = `${prompt}\n\n---\n\n${contents}`;
      } catch {
        return; // Skip: can't read heartbeat file
      }
    }

    const now = new Date();
    const trigger: Trigger = {
      jobId: job.id,
      jobName: job.name,
      target: job.target,
      prompt,
      firedAt: now.toISOString(),
      oneshot: job.oneshot,
    };

    const filename = `${now.getTime()}-${job.id}.json`;
    writeFileSync(join(this.triggersDir, filename), JSON.stringify(trigger, null, 2) + "\n");

    // Update lastFiredAt on the job
    this.store.update(job.id, { lastFiredAt: now.toISOString() });
  }
}
