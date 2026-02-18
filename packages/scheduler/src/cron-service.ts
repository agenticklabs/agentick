import { join } from "node:path";
import type { Job, CronServiceOptions, HeartbeatOptions } from "./types.js";
import { JobStore } from "./job-store.js";
import { TriggerWatcher } from "./trigger-watcher.js";
import { createNodeCronBackend } from "./node-cron-backend.js";
import { createHeartbeatJob } from "./heartbeat.js";
import type { SchedulerBackend } from "./types.js";

export class CronService {
  readonly store: JobStore;
  readonly backend: SchedulerBackend;
  readonly watcher: TriggerWatcher | null;
  private readonly client: CronServiceOptions["client"];
  private readonly defaultTarget: string | undefined;
  private readonly onProcessed: CronServiceOptions["onTriggerProcessed"];
  private readonly onError: CronServiceOptions["onError"];
  private scheduledIds = new Set<string>();

  constructor(options: CronServiceOptions) {
    const jobsDir = join(options.dataDir, "jobs");
    const triggersDir = join(options.dataDir, "triggers");

    this.client = options.client;
    this.defaultTarget = options.defaultTarget;
    this.onProcessed = options.onTriggerProcessed;
    this.onError = options.onError;
    this.store = new JobStore(jobsDir);

    this.backend = options.backend ?? createNodeCronBackend({ triggersDir });

    // External trigger watcher — enabled by default, opt out with watchExternalTriggers: false
    const watchExternal = options.watchExternalTriggers ?? true;
    this.watcher = watchExternal
      ? new TriggerWatcher(triggersDir, options.client, this.store, {
          defaultTarget: options.defaultTarget,
          onTriggerProcessed: options.onTriggerProcessed,
          onError: options.onError,
        })
      : null;
  }

  async start(): Promise<void> {
    // Register all enabled jobs with the backend
    for (const job of this.store.listEnabled()) {
      this.backend.schedule(job, () => this._dispatch(job));
      this.scheduledIds.add(job.id);
    }

    // React to store changes
    this.store.on("change", this._onStoreChange);

    await this.backend.start();
    await this.watcher?.start();
  }

  async stop(): Promise<void> {
    this.store.off("change", this._onStoreChange);
    await this.backend.stop();
    this.watcher?.stop();
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

  private _onStoreChange = (): void => {
    const enabled = new Map(this.store.listEnabled().map((j) => [j.id, j]));

    // Unschedule everything currently tracked
    for (const id of this.scheduledIds) {
      this.backend.unschedule(id);
    }
    this.scheduledIds.clear();

    // Re-schedule enabled jobs
    for (const [, job] of enabled) {
      this.backend.schedule(job, () => this._dispatch(job));
      this.scheduledIds.add(job.id);
    }
  };

  private async _dispatch(job: Job): Promise<void> {
    // Read fresh state — job may have been updated since scheduling
    const current = this.store.get(job.id);
    if (!current || !current.enabled) return;

    const target = current.target || this.defaultTarget;
    if (!target) {
      this.onError?.(
        new Error(`Job "${current.id}" has no target and no default configured`),
        "dispatch",
      );
      return;
    }

    try {
      const session = this.client.session(target);
      const handle = session.send({
        messages: [
          {
            role: "event",
            content: [{ type: "text", text: current.prompt }],
            metadata: {
              source: { type: "cron" },
              event_type: "cron_trigger",
              job_id: current.id,
              job_name: current.name,
              fired_at: new Date().toISOString(),
            },
          },
        ],
      });

      await handle.result;

      // Update lastFiredAt
      this.store.update(current.id, { lastFiredAt: new Date().toISOString() });

      // Oneshot: delete after successful fire
      if (current.oneshot) {
        this.store.delete(current.id);
      }

      this.onProcessed?.({
        jobId: current.id,
        jobName: current.name,
        target,
        prompt: current.prompt,
        firedAt: new Date().toISOString(),
        oneshot: current.oneshot,
      });
    } catch (error) {
      this.onError?.(
        error instanceof Error ? error : new Error(String(error)),
        `dispatch:${current.id}`,
      );
    }
  }
}
