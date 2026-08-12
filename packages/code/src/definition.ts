/**
 * `defineCode` — the code NAMESPACE DEFINITION (ADR 93).
 *
 * Every field is optional, so naming the namespace is enough:
 *
 * ```ts
 * createApp(<Agent />, { code: {} });                       // the default runtime
 * defineCode({ runtime: hostRuntime({ cwd }) });            // a configured one
 * defineCode({ bindings: { tools }, budgets: { timeMs } }); // a base layer
 * ```
 *
 * The default is `@agentick/code-host` — a subprocess of the engine the host
 * app already runs — because it adds no trust boundary that was not already
 * there. What stays refused is a default that ESCALATES.
 *
 * Identity + brand: nothing is constructed and no code runs. Definitions are
 * inert until install, where the harness is built per-session.
 *
 * @see docs/proposals/v2/code.md
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 */

import type { HarnessInterceptors } from "@agentick/runtime";

import type { Code, CodeBindings, CodeBudgets, Runtime, RuntimeProvider } from "./contract.js";

/** Symbol-keyed and non-enumerable, so it stays out of spread-visible shape. */
const CODE_DEFINITION: unique symbol = Symbol("agentick.codeDefinition");

export interface CodeDefinition extends HarnessInterceptors<"code"> {
  /**
   * The engine — a {@link RuntimeProvider} (`hostRuntime()`, `sandboxHost()`)
   * resolved once per session at first use, or a live {@link Runtime} bound
   * directly. Omitted, the install resolves `@agentick/code-host`; absent that,
   * running a program fails `CodeProviderMissing`, naming the install.
   */
  readonly runtime?: Runtime | RuntimeProvider;
  /**
   * The BASE context every program gets. `createContext({ bindings })` merges
   * OVER this per leaf, so a context adds `tools.extra` without wiping the
   * default `tools` and overrides one name without naming the rest.
   */
  readonly bindings?: CodeBindings;
  /** Base ceilings, overridden per key by `createContext({ budgets })`. */
  readonly budgets?: CodeBudgets;
}

export type BrandedCodeDefinition = CodeDefinition & {
  readonly [CODE_DEFINITION]: true;
};

/** Name a code definition (ADR 93). Identity + brand. */
export function defineCode(options: CodeDefinition = {}): BrandedCodeDefinition {
  return Object.defineProperty(options, CODE_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedCodeDefinition;
}

/**
 * Does `value` carry the {@link defineCode} brand? An INLINE bag
 * (`withCode({ runtime })`) — or an empty one — is a valid definition and is
 * NOT branded, so the
 * slot discriminates definition-from-instance with spec's `isCodeInstance` and
 * reaches for this only when the brand itself is the question.
 */
export function isCodeDefinition(value: unknown): value is BrandedCodeDefinition {
  return typeof value === "object" && value !== null && CODE_DEFINITION in value;
}

/**
 * What `withCode` and the `code` slot accept — the ADR-42 dichotomy, no third
 * form: a DEFINITION (constructed per-session) or a LIVE INSTANCE (the adopter
 * owns its lifecycle).
 */
export type CodeConfig = CodeDefinition | Code;
