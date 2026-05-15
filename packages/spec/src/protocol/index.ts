/**
 * Protocol interfaces — contracts between harnesses and substrates.
 *
 * Phase 1c landed: substrate protocols (journal, bus, inbox).
 *
 * Future phases will add:
 *   - reconciler.ts      ReconcilerProtocol + I/O types
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
