import type { AgentickClient } from "@agentick/client";

// Register "cron" as a MessageSource via declaration merging
declare module "@agentick/shared" {
  interface MessageSourceTypes {
    cron: { type: "cron" };
  }
}

export interface Job {
  id: string;
  name: string;
  cron: string;
  target: string;
  prompt: string;
  oneshot: boolean;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Trigger {
  jobId: string;
  jobName: string;
  target: string;
  prompt: string;
  firedAt: string;
  oneshot: boolean;
}

export interface CronServiceOptions {
  dataDir: string;
  client: AgentickClient;
  defaultTarget?: string;
  onTriggerProcessed?: (trigger: Trigger) => void;
  onError?: (error: Error, context: string) => void;
}

export interface HeartbeatOptions {
  cron?: string;
  target?: string;
  heartbeatFile?: string;
}

export type CreateJobInput = Omit<Job, "id" | "createdAt" | "lastFiredAt"> & {
  id?: string;
};
