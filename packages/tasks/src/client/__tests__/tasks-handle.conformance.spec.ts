/**
 * `tasksHandle` — the B2 `ClientHandle` conformance suite (core + Enumerable +
 * the `cancel` write verb). Tasks completes as core + Enumerable + cancel
 * (north-star Q3, RESOLVED) — no Streamable profile.
 *
 * @see docs/proposals/v2/client-handles.md §4
 */

import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core/testing";
import type { TaskInfo, TaskStatus } from "@agentick/spec";

import { tasksHandle, type TasksHandle } from "../tasks-handle.js";
import { TASK_STATUS_CHANNEL } from "../../channel.js";

function taskInfo(taskId: string, status: TaskStatus): TaskInfo {
  return { taskId, status, createdAt: 0, lastUpdatedAt: 0, ttl: null };
}

runClientHandleConformance<TasksHandle, TaskInfo, string>({
  label: "tasksHandle",
  setup() {
    const spy = spyClientTransport();
    const handle = tasksHandle(spy, "sess_1");
    let n = 0;
    return {
      handle,
      // Each change adds a UNIQUE task (live delta = a bare TaskInfo) so list() grows.
      change: () => spy.emit(TASK_STATUS_CHANNEL, taskInfo(`task_${++n}`, "working")),
      teardown: () => spy.endStream(),
    };
  },
  enumerable: {
    // A client connecting mid-run: the opening task-status SNAPSHOT frame IS the
    // pre-connection state; list() must reflect it.
    connectAfterSeed: async () => {
      const spy = spyClientTransport();
      const handle = tasksHandle(spy, "sess_1");
      spy.emit(TASK_STATUS_CHANNEL, { kind: "snapshot", tasks: [taskInfo("t1", "working")] });
      return { handle, id: "t1", teardown: () => spy.endStream() };
    },
    absentId: "never-seen",
  },
  writeVerbs: [
    {
      verb: "cancel",
      method: "tasks/cancel",
      run: async () => {
        const spy = spyClientTransport();
        const handle = tasksHandle(spy, "sess_1");
        await handle.cancel("t1");
        const r = spy.lastRequest()!;
        return { method: r.method, params: r.params };
      },
      boundAddress: { sessionId: "sess_1", taskId: "t1" },
    },
  ],
});
