/**
 * @agentick/code — running model-authored code as a capability.
 *
 * The harness owns the OPERATION: `code:execute` is journaled with the source,
 * its digest and the names of everything in scope, guardable before the
 * provider is touched, and abortable. A `Runtime` provider owns language,
 * engine and isolation — so `code-node`, an in-process isolate and a future
 * Python runtime all sit in this one slot, under this one contract.
 *
 * ```ts
 * import { defineCode } from "@agentick/code";
 *
 * const app = createApp(Agent, { code: {} }); // or defineCode({ runtime })
 *
 * const result = await session.code.execute({
 *   source: "const x = await tools.recall({ q }); return x",
 *   bindings: { tools: { recall: (input) => tools.dispatch("recall", input) } },
 *   budgets: { timeMs: 5_000 },
 * });
 * if (result.outcome === "returned") use(result.value);
 * ```
 *
 * The default provider is `@agentick/code-host` — a subprocess of the engine
 * the host app already runs, so it adds no trust boundary that was not there.
 * What stays refused is a default that ESCALATES: an implicit jail would imply
 * containment nobody built, an implicit isolate a tier nobody chose.
 *
 * @see docs/proposals/v2/code.md
 */

// Side-effect import — registers the `code` slot on `HookBridges`,
// `NamespaceSlots`, `SessionHarnessProtocol` and `ToolHandlerCtxExtensions` via
// TypeScript module augmentation (ADR 27).
import "./augment.js";

export { CodeHarness, type CodeHarnessOptions } from "./harness.js";
export { withCode, EXTENSION_NAME, type WithCodeOptions } from "./extension.js";
export { DEFAULT_RUNTIME_PACKAGE, resolveDefaultRuntime } from "./default-runtime.js";
export {
  defineCode,
  isCodeDefinition,
  type BrandedCodeDefinition,
  type CodeConfig,
  type CodeDefinition,
} from "./definition.js";
export {
  BINDING_PATH_SEPARATOR,
  bindingNames,
  flattenBindings,
  freezeNamespaces,
  MAX_BINDING_DEPTH,
  resolveBindingPath,
  type FlatBindings,
} from "./bindings.js";
export {
  CODE_BUDGET_KEYS,
  isCodeInstance,
  isRuntimeProvider,
  type Code,
  type CodeBinding,
  type CodeBindingScalar,
  type CodeBindingEntry,
  type CodeBindings,
  type CodeBudgetExceeded,
  type CodeBudgetKey,
  type CodeBudgets,
  type CodeCapabilities,
  type CodeContext,
  type CodeContextOptions,
  type CodeExecuteInput,
  type CodeExecuteOptions,
  type CodeExecuteResult,
  type CodeFx,
  type CodeNoValue,
  type CodeOutput,
  type CodeReturned,
  type CodeOneShotInput,
  type CodeRuntimeContext,
  type CodeRuntimeContextOptions,
  type CodeStream,
  type CodeThrew,
  type CodeThrown,
  type Runtime,
  type RuntimeProvider,
} from "./contract.js";
export {
  CodeAborted,
  CodeBudgetUnsupported,
  CodeContextDisposed,
  CodeError,
  CodeProviderMissing,
  CodeRuntimeFailed,
  type CodeErrorChannel,
} from "./errors.js";
// `runCodeConformance` is NOT exported here: it imports vitest, and a
// production consumer of this barrel must not load a test framework. It ships
// from `@agentick/code/testing`.
