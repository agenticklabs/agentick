/**
 * Protocol interfaces — contracts between harnesses and substrates.
 *
 * Phase 1c landed: substrate protocols (journal, bus, inbox).
 * Phase 3.1 landed: reconciler protocol + hook bridges.
 * Phase 4a.1 landed: tool-executor protocol.
 *
 * Future phases will add:
 *   - formatter.ts       FormatterProtocol + I/O types
 *   - loop-executor.ts   LoopExecutorProtocol
 *   - executor.ts        ExecutorProtocol, LanguageModelExecutor
 *   - session-harness.ts SessionHarnessProtocol
 *   - app-harness.ts     AppHarnessProtocol
 *
 * @see docs/proposals/v2/blueprint/01-harness-principle.md
 */

export * from "./journal.js";
export * from "./bus.js";
export * from "./inbox.js";
export * from "./channels.js";
export * from "./reconciler.js";
export * from "./hook-bridges.js";
export * from "./tool-executor.js";
export * from "./executor.js";
export * from "./loop-executor.js";
export * from "./session-harness.js";
