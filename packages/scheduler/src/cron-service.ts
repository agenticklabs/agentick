import { join } from "node:path";
import type { Job, CronServiceOptions, HeartbeatOptions } from "./types.js";
import { JobStore } from "./job-store.js";
import { Scheduler } from "./scheduler.js";
import { TriggerWatcher } from "./trigger-watcher.js";
import { createHeartbeatJob } from "./heartbeat.js";

export class CronService {
  readonly store: JobStore;
  readonly scheduler: Scheduler;
  readonly watcher: TriggerWatcher;

  constructor(options: CronServiceOptions) {
    const jobsDir = join(options.dataDir, "jobs");
    const triggersDir = join(options.dataDir, "triggers");

    this.store = new JobStore(jobsDir);
    this.scheduler = new Scheduler(this.store, triggersDir);
    this.watcher = new TriggerWatcher(triggersDir, options.client, this.store, {
      defaultTarget: options.defaultTarget,
      onTriggerProcessed: options.onTriggerProcessed,
      onError: options.onError,
    });
  }

  async start(): Promise<void> {
    this.scheduler.start();
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    this.watcher.stop();
  }

  /** Ensure a heartbeat job exists — idempotent */
  ensureHeartbeat(options?: HeartbeatOptions): Job {
    const existing = this.store.get("heartbeat");
    if (existing) return existing;
    return this.store.create({
      ...createHeartbeatJob(options),
      id: "heartbeat",
    });
  }
}
