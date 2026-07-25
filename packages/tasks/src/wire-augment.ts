/**
 * Wire-method augmentation — adds the `tasks/*` write rows to the spec
 * `WireMethods` seed. Split out from the server-bridge {@link ../augment.ts} so
 * the CLIENT subpath can type `tasks/cancel` WITHOUT loading the server-bridge
 * augmentations (the `session.tasks` handle issues
 * `client.transport.request("tasks/cancel", …)`).
 *
 * Pure type-only augmentation (zero runtime) — a browser bundle importing it as
 * a side effect pulls no server code. Mirrors `@agentick/knobs`'s
 * `wire-augment.ts`.
 *
 * The `export {}` is load-bearing: without a top-level import/export this file
 * is a SCRIPT, and `declare module "@agentick/spec"` would be read as an
 * ambient module declaration that SHADOWS the real spec module (every export
 * vanishes). The empty export makes it a module, so the block is a merging
 * augmentation instead.
 */

export {};

declare module "@agentick/spec" {
  interface WireMethods {
    /**
     * Cancel a running task by id — the tasks WRITE command (CQRS). The effect
     * (a terminal `cancelled` transition) returns as a `task-status` delta on
     * the channel and re-folds `session.tasks` (no response payload carries
     * state — state flows one way, through the channel).
     */
    "tasks/cancel": {
      params: { sessionId: string; taskId: string; reason?: string };
      result: null;
    };
  }
}
