/**
 * Built-in {@link CompactStrategy} factories — the timeline `/strategies`
 * subpath, parallel to `@agentick/skills/hydrators`.
 *
 * **Naming: these are strategy-value factories, NOT `withX`
 * session-extension factories.** `withX` is reserved house vocabulary for
 * things that install a harness (`withTimeline`, `withSkills`). A strategy
 * factory returns a plain configured `CompactStrategy` VALUE — portable
 * across call altitudes (host slot, component prop, app logic) exactly like
 * a loader's `fromUrl({...})`. They live under `/strategies` so an adopter
 * never confuses `compact: rollingSummary({...})` with an extension install.
 *
 * Step 5a ships the raw escape hatch (`fromHandler`). Named policies
 * (`rollingSummary`, `slidingWindow`) and executor-wired factories land in
 * Step 5b once the dependency direction (timeline ⇆ executor / app) settles.
 * Adopters can write their own — anything returning a {@link CompactStrategy}.
 */

import type { CompactRun, CompactStrategy } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

export interface FromHandlerOptions {
  readonly handler: CompactRun;
  readonly source?: "persisted" | "projection";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The raw, lowest-level strategy: wrap a pure async function over entries
 * into a {@link CompactStrategy} value. The harness reads the source
 * (default "persisted"), passes the entries to `handler`, and uses the
 * handler's return as the new projection.
 */
export function fromHandler(options: FromHandlerOptions): CompactStrategy {
  return {
    source: options.source ?? "persisted",
    run: options.handler,
    ...omitUndefined({ metadata: options.metadata }),
  };
}
