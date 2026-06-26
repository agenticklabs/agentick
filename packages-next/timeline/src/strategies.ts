/**
 * Built-in {@link CompactStrategy} factories.
 *
 * Step 5a ships the lowest-level form (`withHandler`) — a raw async
 * function over entries. Higher-level convenience factories that wire
 * to executors (`withModel`) or to a full sub-agent (`withApp`) land
 * in Step 5b once the dependency direction (timeline ⇆ executor /
 * app) is settled.
 *
 * Adopters can write their own factories — anything that returns a
 * {@link CompactStrategy} works. Examples in the docs cover token-
 * budget windowing, sliding-window summarization, semantic dedup, etc.
 */

import type { CompactRun, CompactStrategy } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

export interface WithHandlerOptions {
  readonly handler: CompactRun;
  readonly source?: "persisted" | "projection";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The raw, lowest-level strategy: a pure async function over entries.
 * The harness reads the source (default "persisted"), passes the
 * entries to `handler`, and uses the handler's return as the new
 * projection.
 */
export function withHandler(options: WithHandlerOptions): CompactStrategy {
  return {
    source: options.source ?? "persisted",
    run: options.handler,
    ...omitUndefined({ metadata: options.metadata }),
  };
}
