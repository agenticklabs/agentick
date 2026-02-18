import cron, { type ScheduledTask } from "node-cron";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Job, Trigger, SchedulerBackend } from "./types.js";

export interface NodeCronBackendOptions {
  /** Directory for trigger files (crash recovery). If omitted, no trigger files — fires directly. */
  triggersDir?: string;
}

interface ScheduledEntry {
  task: ScheduledTask;
  cronExpr: string;
  onFire: () => Promise<void>;
}

/**
 * In-process scheduling via node-cron. Optionally writes trigger files for
 * crash recovery — if the process dies between fire and dispatch, trigger
 * files persist and are drained on next `start()`.
 */
export function createNodeCronBackend(options?: NodeCronBackendOptions): SchedulerBackend {
  const timers = new Map<string, ScheduledEntry>();
  const triggersDir = options?.triggersDir;
  const pendingCallbacks = new Map<string, () => Promise<void>>();

  if (triggersDir) {
    mkdirSync(triggersDir, { recursive: true });
  }

  return {
    async start() {
      if (triggersDir) {
        await drainPendingTriggers(triggersDir, pendingCallbacks);
      }
    },

    async stop() {
      for (const [id, entry] of timers) {
        entry.task.stop();
        timers.delete(id);
      }
    },

    schedule(job: Job, onFire: () => Promise<void>) {
      if (!cron.validate(job.cron)) return;

      // Store callback for crash recovery drain
      pendingCallbacks.set(job.id, onFire);

      const wrappedFire = triggersDir
        ? () => fireWithTriggerFile(triggersDir, job, onFire)
        : () => {
            onFire();
          };

      const task = cron.schedule(job.cron, wrappedFire);
      timers.set(job.id, { task, cronExpr: job.cron, onFire });
    },

    unschedule(jobId: string) {
      const entry = timers.get(jobId);
      if (entry) {
        entry.task.stop();
        timers.delete(jobId);
      }
      pendingCallbacks.delete(jobId);
    },
  };
}

/** Write trigger file, call onFire, delete file on success. */
function fireWithTriggerFile(triggersDir: string, job: Job, onFire: () => Promise<void>): void {
  // Heartbeat pre-filter: read heartbeat file, skip if empty/missing
  let prompt = job.prompt;
  const heartbeatFile = job.metadata?.heartbeatFile as string | undefined;
  if (heartbeatFile) {
    try {
      if (!existsSync(heartbeatFile)) return;
      const contents = readFileSync(heartbeatFile, "utf-8").trim();
      if (!contents) return;
      prompt = `${prompt}\n\n---\n\n${contents}`;
    } catch {
      return;
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
  const filepath = join(triggersDir, filename);
  writeFileSync(filepath, JSON.stringify(trigger, null, 2) + "\n");

  // Fire callback, clean up trigger file on success
  onFire()
    .then(() => {
      try {
        unlinkSync(filepath);
      } catch {}
    })
    .catch(() => {
      // Trigger file persists for retry on next start
    });
}

/** Drain trigger files that survived a crash. */
async function drainPendingTriggers(
  triggersDir: string,
  callbacks: Map<string, () => Promise<void>>,
): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(triggersDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return;
  }

  for (const file of files) {
    const filepath = join(triggersDir, file);
    try {
      const raw = readFileSync(filepath, "utf-8");
      const trigger = JSON.parse(raw) as Trigger;
      const callback = callbacks.get(trigger.jobId);
      if (callback) {
        await callback();
      }
      unlinkSync(filepath);
    } catch {
      // Skip malformed trigger files
      try {
        unlinkSync(filepath);
      } catch {}
    }
  }
}
