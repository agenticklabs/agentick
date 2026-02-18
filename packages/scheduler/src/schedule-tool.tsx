import React from "react";
import cron from "node-cron";
import { createTool, Section } from "@agentick/core";
import { z } from "zod";
import type { JobStore } from "./job-store.js";

function formatJob(j: {
  id: string;
  name: string;
  cron: string;
  target: string;
  oneshot: boolean;
  enabled: boolean;
}): string {
  const flags = [j.oneshot ? "oneshot" : null, !j.enabled ? "disabled" : null].filter(Boolean);
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${j.id}: "${j.name}" (${j.cron}) → ${j.target}${suffix}`;
}

export function createScheduleTool(store: JobStore) {
  return createTool({
    name: "schedule",
    description:
      "Manage scheduled jobs. 'add' to create a recurring/oneshot job, " +
      "'list' to see all jobs, 'remove' to delete, 'enable'/'disable' to toggle.",
    displaySummary: (input) => {
      if (input.action === "add") return `add: ${input.name ?? "unnamed"}`;
      if (input.action === "list") return "list";
      return `${input.action}: ${input.id}`;
    },
    input: z.object({
      action: z.enum(["add", "list", "remove", "enable", "disable"]),
      name: z.string().optional().describe("Job name (add)"),
      cron: z.string().optional().describe("Cron expression, e.g. '*/5 * * * *' (add)"),
      target: z.string().optional().describe("Target session ID, e.g. 'tui', 'telegram' (add)"),
      prompt: z.string().optional().describe("Prompt sent when job fires (add)"),
      oneshot: z.boolean().optional().describe("Delete after first fire (add, default false)"),
      id: z.string().optional().describe("Job ID (remove/enable/disable)"),
    }),
    handler: (input) => {
      switch (input.action) {
        case "add": {
          if (!input.name || !input.cron || !input.prompt) {
            return [
              { type: "text" as const, text: "Error: 'add' requires name, cron, and prompt." },
            ];
          }
          if (!cron.validate(input.cron)) {
            return [
              { type: "text" as const, text: `Error: invalid cron expression "${input.cron}".` },
            ];
          }
          const job = store.create({
            name: input.name,
            cron: input.cron,
            target: input.target ?? "tui",
            prompt: input.prompt,
            oneshot: input.oneshot ?? false,
            enabled: true,
          });
          return [{ type: "text" as const, text: `Created job: ${formatJob(job)}` }];
        }
        case "list": {
          const jobs = store.list();
          if (jobs.length === 0) {
            return [{ type: "text" as const, text: "No scheduled jobs." }];
          }
          return [{ type: "text" as const, text: jobs.map(formatJob).join("\n") }];
        }
        case "remove": {
          if (!input.id) {
            return [{ type: "text" as const, text: "Error: 'remove' requires an id." }];
          }
          const deleted = store.delete(input.id);
          if (!deleted) {
            return [{ type: "text" as const, text: `Error: job "${input.id}" not found.` }];
          }
          return [{ type: "text" as const, text: `Removed job "${input.id}".` }];
        }
        case "enable": {
          if (!input.id) {
            return [{ type: "text" as const, text: "Error: 'enable' requires an id." }];
          }
          const job = store.update(input.id, { enabled: true });
          if (!job) {
            return [{ type: "text" as const, text: `Error: job "${input.id}" not found.` }];
          }
          return [{ type: "text" as const, text: `Enabled job "${input.id}".` }];
        }
        case "disable": {
          if (!input.id) {
            return [{ type: "text" as const, text: "Error: 'disable' requires an id." }];
          }
          const job = store.update(input.id, { enabled: false });
          if (!job) {
            return [{ type: "text" as const, text: `Error: job "${input.id}" not found.` }];
          }
          return [{ type: "text" as const, text: `Disabled job "${input.id}".` }];
        }
      }
    },
    render: () => {
      const jobs = store.listEnabled();
      if (jobs.length === 0) return null;
      return <Section id="scheduled-jobs">{jobs.map(formatJob).join("\n")}</Section>;
    },
  });
}
