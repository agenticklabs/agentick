/**
 * `useData` — blocking async data resolution for the React compiler.
 * NOT React Suspense.
 *
 * Composes the compiler-agnostic `DataBridge` primitives
 * (`peek` + `fetch`) into React's throw-on-pending pattern:
 *
 *   - cached value   → returns synchronously
 *   - cached error   → throws the error synchronously
 *   - pending fetch  → throws the in-flight Promise (the compiler's
 *                      render-until-stable loop catches, awaits, and
 *                      re-renders — never reaches React Suspense)
 *   - no entry yet   → initiates the fetch via `fetch`, throws the
 *                      returned Promise
 *
 * The component sees a real value or a real error — never a "loading"
 * sentinel. The `RenderedTree` reflects fully-resolved state.
 *
 * Non-React compilers (Angular, Vue, signal-based) compose the same
 * primitives into their own async idiom.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §DataBridge
 */

import type { DataResolveOptions } from "@agentick/spec";
import { useBridges } from "../bridge-context.js";

export function useData<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: DataResolveOptions,
): T {
  const { data } = useBridges();
  const entry = data.peek<T>(key);
  if (entry?.kind === "value") return entry.value;
  if (entry?.kind === "pending") throw entry.promise;
  if (entry?.kind === "error") throw entry.error;
  // No entry yet — initiate the fetch and throw the in-flight Promise.
  throw data.fetch(key, fetcher, options);
}
