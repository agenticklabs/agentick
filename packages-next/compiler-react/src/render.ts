/**
 * `render(element, opts?)` — convenience entry point: compile the
 * React element to IR, then run the formatter pipeline to produce a
 * string. Default formatter is markdown; override via `opts.formatter`.
 *
 * Adopters who want the IR (e.g. to format it themselves, inspect it,
 * cache it, ship it over a wire) call `compileToTree` directly.
 */

import { format, type FormatOptions } from "@agentick/compiler-next";
import type { ReactNode } from "react";

import { compileToTree, type CompileToTreeOptions } from "./compile.js";

export interface RenderOptions extends CompileToTreeOptions, FormatOptions {}

export async function render(element: ReactNode, opts: RenderOptions = {}): Promise<string> {
  const tree = await compileToTree(element, opts);
  return format(tree, opts);
}
