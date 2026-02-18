# @agentick/scheduler

Scheduled jobs for Agentick agents. Pluggable backends, file-based persistence,
crash recovery.

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

## Architecture

```
CronService
  ├── JobStore                    (persistent job definitions)
  ├── SchedulerBackend            (pluggable — when to fire)
  │     └── NodeCronBackend       (default, in-process timers)
  └── TriggerWatcher (optional)   (external trigger pickup)
```

**JobStore** persists jobs as individual JSON files in `<dataDir>/jobs/`.
Survives crashes.

**SchedulerBackend** is the pluggable timer mechanism. When a job fires, it
calls the `onFire` callback provided by CronService, which dispatches to the
target session via `client.session(target).send()`.

**TriggerWatcher** watches `<dataDir>/triggers/` for externally-written JSON
files. System cron, scripts, webhooks — anything that writes a trigger file
wakes the agent. Enabled by default, opt out with `watchExternalTriggers: false`.

## Backend Interface

```typescript
interface SchedulerBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  schedule(job: Job, onFire: () => Promise<void>): void;
  unschedule(jobId: string): void;
}
```

Four methods. `start`/`stop` for lifecycle. `schedule`/`unschedule` for per-job
timer management. The backend decides everything about HOW and WHEN — timers,
durability, retries. Dispatch is CronService's job.

### NodeCronBackend (default)

In-process scheduling via `node-cron`. Writes trigger files for crash recovery —
if the process dies between fire and dispatch, trigger files persist and are
drained on next `start()`.

```typescript
import { createNodeCronBackend } from "@agentick/scheduler";

const backend = createNodeCronBackend({ triggersDir: ".myagent/triggers" });
```

### Custom Backends

Implement `SchedulerBackend` for any timer source. Durability is the
backend's problem — not the framework's.

```typescript
// BullMQ example (conceptual)
const bullBackend: SchedulerBackend = {
  async start() { /* connect to Redis, start worker */ },
  async stop() { /* close connections */ },
  schedule(job, onFire) { /* create repeatable BullMQ job */ },
  unschedule(jobId) { /* remove BullMQ job scheduler */ },
};

const service = new CronService({
  dataDir: ".myagent",
  client,
  backend: bullBackend,
  watchExternalTriggers: false,
});
```

## Agent Tool

`createScheduleTool` returns a tool the agent uses to manage its schedule.
Actions: `add`, `list`, `remove`, `enable`, `disable`.

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

cronService.store.create({
  ...createHeartbeatJob({
    cron: "*/5 * * * *",
    target: "tui",
    heartbeatFile: ".myagent/HEARTBEAT.md",
  }),
  id: "heartbeat",
});
```

## External Triggers

Anything that writes a JSON file to the triggers directory wakes the agent.

```bash
echo '{"target":"tui","prompt":"wake up","jobId":"manual","jobName":"manual","firedAt":"2025-01-01T00:00:00Z","oneshot":true}' \
  > .myagent/triggers/$(date +%s)-manual.json
```

## CronService Options

```typescript
interface CronServiceOptions {
  dataDir: string;               // Root dir — jobs/ and triggers/ live here
  client: AgentickClient;        // Client for sending messages to sessions
  backend?: SchedulerBackend;    // Default: NodeCronBackend
  watchExternalTriggers?: boolean; // Default: true
  defaultTarget?: string;        // Fallback session ID
  onTriggerProcessed?: (trigger: Trigger) => void;
  onError?: (error: Error, context: string) => void;
}
```

## Exports

```typescript
export { CronService } from "./cron-service.js";
export { JobStore } from "./job-store.js";
export { createNodeCronBackend } from "./node-cron-backend.js";
export { TriggerWatcher } from "./trigger-watcher.js";
export { createScheduleTool } from "./schedule-tool.js";
export { createHeartbeatJob } from "./heartbeat.js";
export { bindSchedulerStore, getSchedulerStore } from "./bridge.js";
export type {
  Job,
  Trigger,
  SchedulerBackend,
  CronServiceOptions,
  HeartbeatOptions,
  CreateJobInput,
} from "./types.js";
```
