/**
 * Preload shim for the no-TLA gate — registers the dist-resolving loader
 * ({@link ./no-tla-hooks.mjs}) so the probe subprocess resolves every
 * `@agentick/*` dependency to its BUILT dist (the published-resolution
 * reproduction). Loaded via `node --import ./scripts/no-tla-register.mjs`.
 */
import { register } from "node:module";
register("./no-tla-hooks.mjs", import.meta.url);
