/**
 * Module augmentation — adds the `live` slot to TWO spec interfaces:
 *
 *   1. `HookBridges.live`             → render-time access for in-tree
 *                                       harnesses (a `<Live>`-style component
 *                                       reaching the stream registry).
 *   2. `SessionHarnessProtocol.live`  → server-side access for host code (the
 *                                       `live/*` wire handlers, tool-handler
 *                                       ctx) that opens / stops / interrupts
 *                                       streams.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the spec's empty
 * seed with its own slot; the spec stays neutral. `live` is an OPTIONAL
 * extension, so both slots are OPTIONAL (`?`) — a session without `withLive`
 * never sees them.
 *
 * Loaded as a side effect when anything imports from `@agentick/live`. The
 * top-level `import type` makes this a module (not an ambient script), so the
 * `declare module` blocks MERGE into the spec rather than SHADOW it.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import type { Live } from "@agentick/spec";

declare module "@agentick/spec" {
  interface HookBridges {
    /**
     * The live media-session registry for this session — present only when
     * `withLive` is installed (OPTIONAL extension). Same instance as
     * `session.live` and the tool-handler `ctx`.
     */
    readonly live?: Live;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's live surface — the same `LiveHarness` the `live/*` wire
     * handlers drive (`start` / `stop` / `interrupt`) and `bridges.live`
     * resolves. Optional: present only when `withLive` is installed.
     */
    readonly live?: Live;
  }
}
