/**
 * Brand symbol for ExecutionHandle objects.
 *
 * ExecutionTracker uses this to distinguish handles (which are AsyncIterable
 * but manage their own lifecycle) from pure async generators (where iteration
 * IS the execution). Branded objects pass through the tracker without wrapping.
 *
 * Lives in its own module to avoid TDZ issues — procedure.ts uses it as a
 * computed class field key, so the symbol must be initialized before the
 * class body evaluates. Circular import chains through execution-tracker.ts
 * can delay initialization; this leaf module has no such risk.
 */
export const ExecutionHandleBrand: unique symbol = Symbol("agentick.execution-handle");
