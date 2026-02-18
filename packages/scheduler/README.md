# @agentick/scheduler

Scheduled jobs, heartbeat, and cron triggers for Agentick agents. File-based
persistence with crash recovery.

## Install

```sh
pnpm add @agentick/scheduler
```

## Quick Start

```typescript
import { createClient } from "@agentick/client";
import { CronService, createScheduleTool, bindSchedulerStore } from "@agentick/scheduler";

const cronService = new CronService({
  dataDir: ".myagent",
  client,
  defaultTarget: "tui",
});
await cronService.start();

// Give the agent a tool to manage its own schedule
const ScheduleTool = createScheduleTool(cronService.store);
```

## How It Works

```
CronService
  ├── JobStore          .myagent/jobs/*.json       (persistent job definitions)
  ├── Scheduler         node-cron timers           (fires → writes trigger files)
  └── TriggerWatcher    .myagent/triggers/*.json   (watches → sends to session)
```

1. **JobStore** persists jobs as individual JSON files. Survives crashes.
2. **Scheduler** creates node-cron timers for enabled jobs. When a timer fires,
   it writes a trigger file.
3. **TriggerWatcher** watches the triggers directory with `fs.watch`. On new
   file: reads the trigger, sends the prompt to the target session via
   `client.session(target).send()`, deletes the file. Oneshot jobs are removed
   after first fire.

On startup, `TriggerWatcher` drains any pending trigger files that accumulated
while the process was down.

## Agent Tool

`createScheduleTool` returns a tool the agent can use to manage its own
schedule. Actions: `add`, `list`, `remove`, `enable`, `disable`.

```tsx
import { createScheduleTool } from "@agentick/scheduler";

const ScheduleTool = createScheduleTool(cronService.store);

// In your component tree:
<ScheduleTool />;
```

The tool's `render` function puts active jobs in context so the model knows
what's already scheduled.

## Heartbeat

A heartbeat is a recurring job that reads a file and prompts the agent to act
on its contents. If the file is empty or missing, the trigger is skipped.

```typescript
import { createHeartbeatJob } from "@agentick/scheduler";

const heartbeat = createHeartbeatJob({
  cron: "*/5 * * * *",
  target: "tui",
  heartbeatFile: ".myagent/HEARTBEAT.md",
});

cronService.store.create(heartbeat);
```

## External Triggers

Anything that writes a JSON file to the triggers directory wakes the agent.
No process needed — system cron, scripts, or manual writes all work.

```bash
echo '{"target":"tui","prompt":"wake up","jobId":"manual","jobName":"manual","firedAt":"2025-01-01T00:00:00Z","oneshot":true}' \
  > .myagent/triggers/$(date +%s)-manual.json
```

## Bridge

Global singleton for sharing the store across modules.

```typescript
import { bindSchedulerStore, getSchedulerStore } from "@agentick/scheduler";

// In main.ts — bind once
bindSchedulerStore(cronService.store);

// In agent component — retrieve
const store = getSchedulerStore();
```

## CronService Options

```typescript
interface CronServiceOptions {
  dataDir: string; // Root dir — jobs/ and triggers/ live here
  client: AgentickClient; // Client for sending messages to sessions
  defaultTarget?: string; // Fallback session ID
  onTriggerProcessed?: (trigger: Trigger) => void;
  onError?: (error: Error, context: string) => void;
}
```

## Exports

```typescript
export { CronService } from "./cron-service.js";
export { JobStore } from "./job-store.js";
export { Scheduler } from "./scheduler.js";
export { TriggerWatcher } from "./trigger-watcher.js";
export { createScheduleTool } from "./schedule-tool.js";
export { createHeartbeatJob } from "./heartbeat.js";
export { bindSchedulerStore, getSchedulerStore } from "./bridge.js";
export type {
  Job,
  Trigger,
  CronServiceOptions,
  HeartbeatOptions,
  CreateJobInput,
} from "./types.js";
```
