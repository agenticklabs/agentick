/**
 * `useSession` — current session identity / status.
 *
 * Read-only snapshot of the `SessionBridge`. Status changes are not
 * reactive on this hook today (the bridge does not expose a
 * subscribe) — session-status reactivity belongs to the session
 * harness's event surface; subscribe to bus events for status changes.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §SessionBridge
 */

import type { SessionBridge } from "@agentick/spec-next";
import { useBridges } from "../bridge-context.js";

export function useSession(): SessionBridge {
  return useBridges().session;
}
