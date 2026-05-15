/**
 * `useData` — blocking async data resolution. NOT React Suspense.
 *
 * Returns the cached value synchronously when present; throws the
 * in-flight Promise when not (which the reconciler's
 * render-until-stable loop catches, awaits, and re-renders); throws
 * the underlying error when a prior fetch rejected.
 *
 * The component sees a real value or a real error — never a "loading"
 * sentinel. The `RenderedTree` reflects fully-resolved state.
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
  return data.resolve(key, fetcher, options);
}
