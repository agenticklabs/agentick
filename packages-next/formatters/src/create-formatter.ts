/**
 * `createFormatter` — author entry point for content formatters.
 *
 * A {@link Formatter} is a pure function `(SemanticContentBlock[]) →
 * ContentBlock[]`. `createFormatter` decorates the render function with
 * identity metadata (`id`, `format`, `version`) so the reconciler's
 * formatter registry can dispatch by {@link FormatterRef} and so traces
 * can record which formatter ran.
 *
 * Per ADR 36 (define vs create): formatters need no parent-harness
 * substrate to construct, so the verb is `create`, not `define`. The
 * return type {@link DefinedFormatter} keeps its name — type names are
 * not covered by the convention.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2 + §D6
 * @see docs/proposals/v2/blueprint/36-define-vs-create-convention.md
 */

import type {
  ContentBlock,
  Formatter,
  FormatterIdentity,
  FormatterRef,
  SemanticContentBlock,
} from "@agentick/spec-next";

export interface CreateFormatterInput extends FormatterIdentity {
  readonly render: (blocks: readonly SemanticContentBlock[]) => readonly ContentBlock[];
}

/**
 * A `Formatter` function decorated with its identity metadata.
 * The reconciler reads `__identity` to build the `FormatterRef` used in
 * `MessageEntry.renderedWith` / `SectionEntry.renderedWith`.
 */
export interface DefinedFormatter extends Formatter {
  readonly __identity: FormatterIdentity;
}

export function createFormatter(spec: CreateFormatterInput): DefinedFormatter {
  const identity: FormatterIdentity = {
    id: spec.id,
    format: spec.format,
    ...(spec.version !== undefined ? { version: spec.version } : {}),
  };
  const fn: DefinedFormatter = Object.assign(
    (blocks: readonly SemanticContentBlock[]) => spec.render(blocks),
    { __identity: identity },
  );
  return fn;
}

/** Resolve a `FormatterRef` from a defined formatter. */
export function refOf(formatter: DefinedFormatter): FormatterRef {
  return formatter.__identity;
}
