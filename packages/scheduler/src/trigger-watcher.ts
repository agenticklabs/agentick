import {
  watch,
  type FSWatcher,
  readdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentickClient } from "@agentick/client";
import type { Trigger, CronServiceOptions } from "./types.js";
import type { JobStore } from "./job-store.js";

export class TriggerWatcher {
  private watcher: FSWatcher | null = null;
  private readonly triggersDir: string;
  private readonly client: AgentickClient;
  private readonly store: JobStore;
  private readonly defaultTarget: string | undefined;
  private readonly onProcessed: ((trigger: Trigger) => void) | undefined;
  private readonly onError: ((error: Error, context: string) => void) | undefined;
  private processing = new Set<string>();
  private stopped = false;

  constructor(
    triggersDir: string,
    client: AgentickClient,
    store: JobStore,
    options?: Pick<CronServiceOptions, "defaultTarget" | "onTriggerProcessed" | "onError">,
  ) {
    this.triggersDir = triggersDir;
    this.client = client;
    this.store = store;
    this.defaultTarget = options?.defaultTarget;
    this.onProcessed = options?.onTriggerProcessed;
    this.onError = options?.onError;
    mkdirSync(triggersDir, { recursive: true });
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Drain any pending triggers from before process started
    await this._drainPending();
    // Watch for new triggers
    this.watcher = watch(this.triggersDir, (eventType, filename) => {
      if (this.stopped) return;
      if (eventType === "rename" && filename?.endsWith(".json")) {
        this._processFile(filename);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async _drainPending(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.triggersDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      if (this.stopped) break;
      await this._processFile(file);
    }
  }

  private async _processFile(filename: string): Promise<void> {
    // Deduplicate: fs.watch fires multiple events for the same file
    if (this.processing.has(filename)) return;
    this.processing.add(filename);

    const filepath = join(this.triggersDir, filename);
    try {
      if (!existsSync(filepath)) return;

      const raw = readFileSync(filepath, "utf-8");
      const trigger = JSON.parse(raw) as Trigger;

      if (!trigger.target && !this.defaultTarget) {
        this.onError?.(
          new Error(`Trigger ${filename} has no target and no default configured`),
          "processFile",
        );
        return;
      }

      const target = trigger.target || this.defaultTarget!;

      // Send as an event-role message — this is a system event, not a user turn
      const session = this.client.session(target);
      const handle = session.send({
        messages: [
          {
            role: "event",
            content: [{ type: "text", text: trigger.prompt }],
            metadata: {
              source: { type: "cron" },
              event_type: "cron_trigger",
              job_id: trigger.jobId,
              job_name: trigger.jobName,
              fired_at: trigger.firedAt,
            },
          },
        ],
      });

      // Wait for the model to process — don't delete trigger until delivery confirmed
      await handle.result;

      // Delete trigger file after successful delivery
      try {
        unlinkSync(filepath);
      } catch {
        // Already cleaned up
      }

      // If oneshot, delete the job
      if (trigger.oneshot) {
        this.store.delete(trigger.jobId);
      }

      this.onProcessed?.(trigger);
    } catch (error) {
      this.onError?.(
        error instanceof Error ? error : new Error(String(error)),
        `processFile:${filename}`,
      );
    } finally {
      this.processing.delete(filename);
    }
  }
}
