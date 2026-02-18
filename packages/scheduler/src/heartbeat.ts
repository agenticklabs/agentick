import type { HeartbeatOptions, CreateJobInput } from "./types.js";

export function createHeartbeatJob(opts?: HeartbeatOptions): CreateJobInput {
  return {
    name: "heartbeat",
    cron: opts?.cron ?? "*/5 * * * *",
    target: opts?.target ?? "tui",
    prompt:
      "[heartbeat] Review your heartbeat file and act on any due, prioritized, or in-progress work.",
    oneshot: false,
    enabled: true,
    metadata: {
      heartbeatFile: opts?.heartbeatFile ?? ".tentickle/HEARTBEAT.md",
    },
  };
}
