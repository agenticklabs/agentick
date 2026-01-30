/**
 * Internal Context Exports
 *
 * Exports the raw React context objects for use by TentickleComponent.
 * These are internal and should not be used directly by application code.
 *
 * Use the hooks from ./context.ts instead (useCom, useTickState).
 */

import { createContext } from "react";
import type { TickState } from "./types";
import type { COM } from "../com/object-model";

/**
 * Internal: COM Context object.
 * Use useCom() hook instead of consuming this directly.
 */
export const COMContext = createContext<COM | null>(null);

/**
 * Internal: TickState Context object.
 * Use useTickState() hook instead of consuming this directly.
 */
export const TickStateContext = createContext<TickState | null>(null);
