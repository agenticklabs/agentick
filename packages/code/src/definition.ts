/**
 * `defineCode` — the code NAMESPACE DEFINITION (ADR 93).
 *
 * One seam: `runtime`, the provider this session executes with, and it is
 * REQUIRED. Declaring the namespace is the same act as choosing what will run
 * the code — there is no configuration in between, and a `defineCode()` that
 * type-checked would read as a complete installation that can do nothing.
 *
 * ```ts
 * export default defineCode({ runtime: nodeRuntime({ host: sandbox.get("primary") }) });
 * ```
 *
 * An adopter who genuinely needs the harness before the provider is chosen
 * builds one and binds later — `new CodeHarness(...)` + `bindRuntime`, handed
 * to `withCode` as a live instance. That path is deliberately more work than
 * naming a runtime, and `CodeProviderMissing` guards its window.
 *
 * Identity + brand: nothing is constructed and no code runs. Definitions are
 * inert until install, where the harness is built per-session.
 *
 * @see docs/proposals/v2/code.md
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 */

import type { Code, Runtime } from "./contract.js";

/** Symbol-keyed and non-enumerable, so it stays out of spread-visible shape. */
const CODE_DEFINITION: unique symbol = Symbol("agentick.codeDefinition");

export interface CodeDefinition {
  /** The provider. Required — there is no default, and no half-installation. */
  readonly runtime: Runtime;
}

export type BrandedCodeDefinition = CodeDefinition & {
  readonly [CODE_DEFINITION]: true;
};

/** Name a code definition (ADR 93). Identity + brand. */
export function defineCode(options: CodeDefinition): BrandedCodeDefinition {
  return Object.defineProperty(options, CODE_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedCodeDefinition;
}

/**
 * Does `value` carry the {@link defineCode} brand? An INLINE bag
 * (`withCode({ runtime })`) is a valid definition and is NOT branded, so the
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
