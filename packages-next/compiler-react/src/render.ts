/**
 * `render(element, opts?)` — convenience entry: compile to IR, then
 * run the formatter pipeline to produce a string. Default formatter
 * is markdown; override via `opts.formatter`.
 *
 * Adopters who want the IR itself (to inspect, cache, ship over a
 * wire) call `compileToTree` directly.
 */

import { format, type FormatOptions } from "@agentick/compiler-next";
import type { ReactNode } from "react";

import { compileToTree, type CompileToTreeOptions } from "./compile.js";

export interface RenderOptions extends CompileToTreeOptions, FormatOptions {}

export async function render(element: ReactNode, opts: RenderOptions = {}): Promise<string> {
  const tree = await compileToTree(element, opts);
  return format(tree, opts);
}
