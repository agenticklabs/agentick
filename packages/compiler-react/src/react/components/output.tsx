/**
 * `<Output>` — typed PascalCase wrapper around the `<output>` intrinsic
 * (three-audiences-plan §B2).
 *
 * Declares the shape THIS agent's every execution produces — dedicated
 * extraction agents, skill-runner children, forks. It compiles to
 * `RenderedTree.declarations.outputs`; the loop consumes the first entry to
 * derive an `OutputSpec` and deliver the answer via a synthetic TERMINAL TOOL
 * (its `inputSchema` IS the `schema`) when the turn exposes model tools, or a
 * plain `responseFormat` directive on a bare send. The captured value is
 * validated against `schema` into `SendResult.data`.
 *
 * A send-level `SendInput.output` OVERRIDES this declaration
 * (explicit-beats-ambient) — the tree form is for "always this shape", the
 * send form for "this execution's shape".
 *
 * `<output>` is a PascalCase-only wrapper: the lowercase intrinsic collides
 * with HTML's form-`<output>` element, so it is omitted from the JSX
 * namespace and reached via `React.createElement("output")`.
 *
 * Props (from {@link OutputProps}):
 *   - `schema`      — the output-shape validator (any `StandardSchemaV1`).
 *   - `name`        — terminal-tool name (default `"submit_result"`).
 *   - `description` — terminal-tool "when done, call this" instruction.
 *   - `strategy`    — `"auto"` (default) | `"tool"` | `"responseFormat"`.
 *
 * @see packages/compiler/src/collect/contributors/output.ts
 * @see docs/proposals/v2/three-audiences-plan.md §B2
 */

import React from "react";
import type { OutputProps } from "@agentick/compiler";

export type { OutputProps };

export function Output(props: OutputProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("output" as any, props);
}
Output.displayName = "Output";
