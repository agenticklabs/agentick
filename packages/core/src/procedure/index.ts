/**
 * Engine procedure utilities for creating middleware-wrapped procedures.
 *
 * Middleware is now registered via Agentick.use() and resolved at runtime from context.
 *
 * @module agentick/procedure
 */

import { applyRegistryMiddleware, wrapProcedure, isProcedure } from "@agentick/kernel";
import { errorMiddleware } from "../middleware/defaults.js";

/**
 * Create an engine procedure with standard middleware.
 *
 * Note: Global middleware is now resolved from context.middleware at runtime,
 * not applied statically here. Use Agentick.use() to register middleware.
 */
export const createEngineProcedure = wrapProcedure([errorMiddleware]);

// Re-export helpers for convenience
export { applyRegistryMiddleware, isProcedure };
