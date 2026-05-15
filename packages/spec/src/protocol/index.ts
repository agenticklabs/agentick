/**
 * Protocol interfaces — contracts between harnesses and substrates.
 *
 * Phase 1c landed: substrate protocols (journal, bus, inbox).
 * Phase 3.1 landed: reconciler protocol + hook bridges.
 *
 * Future phases will add:
 *   - formatter.ts       FormatterProtocol + I/O types
 *   - loop-executor.ts   LoopExecutorProtocol
 *   - executor.ts        ExecutorProtocol, LanguageModelExecutor
 *   - tool-executor.ts   ToolExecutorProtocol
 *   - session-harness.ts SessionHarnessProtocol
 *   - app-harness.ts     AppHarnessProtocol
 *
 * @see docs/proposals/v2/blueprint/01-harness-principle.md
 */

export * from "./journal.js";
export * from "./bus.js";
export * from "./inbox.js";
export * from "./reconciler.js";
export * from "./hook-bridges.js";
