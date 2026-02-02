/**
 * Engine procedure utilities for creating middleware-wrapped procedures.
 *
 * Middleware is now registered via Tentickle.use() and resolved at runtime from context.
 *
 * @module tentickle/procedure
 */

import { applyRegistryMiddleware, wrapProcedure, isProcedure } from "@tentickle/kernel";
import { errorMiddleware } from "../middleware/defaults";

/**
 * Create an engine procedure with standard middleware.
 *
 * Note: Global middleware is now resolved from context.middleware at runtime,
 * not applied statically here. Use Tentickle.use() to register middleware.
 */
export const createEngineProcedure = wrapProcedure([errorMiddleware]);

// Re-export helpers for convenience
export { applyRegistryMiddleware, isProcedure };
