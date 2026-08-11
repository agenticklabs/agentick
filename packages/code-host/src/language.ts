/**
 * What source the provider accepts — and, for TypeScript, what it does to it
 * before the engine sees it.
 *
 * TypeScript is a MODE of this provider rather than a second one: JavaScript is
 * valid TypeScript, so a TS-mode runtime accepts every program a JS-mode
 * runtime does, and the only difference is that types are erased on the way.
 *
 * The erasure is TRANSPILE-ONLY. esbuild strips types without checking them, so
 * a type error does not stop a program — it reaches the engine and surfaces at
 * runtime, or not at all. Type CHECKING is a policy seam (`guard({ codeExecute })`),
 * and the README says how to write one.
 */

import { transform, type Message } from "esbuild";

export type HostLanguage = "javascript" | "typescript";

export type Transpiled =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly message: string };

/**
 * A program is an async function BODY, which no parser accepts: top-level
 * `return` and top-level `await` are never both legal in one esbuild format.
 * Wrapping in a declaration makes both ordinary; the CALL is appended to the
 * output rather than the input, where it would be that top-level return.
 */
const OPEN = "async function __agentick_program() {\n";
const CLOSE = "\n}";
const CALL = "\nreturn await __agentick_program();";

/** Identity for JavaScript, so `execute` has one path instead of a branch. */
export function transpiler(language: HostLanguage): (source: string) => Promise<Transpiled> {
  if (language === "javascript") return (source) => Promise.resolve({ ok: true, source });
  return stripTypes;
}

async function stripTypes(source: string): Promise<Transpiled> {
  try {
    const { code } = await transform(`${OPEN}${source}${CLOSE}`, { loader: "ts" });
    return { ok: true, source: `${code}${CALL}` };
  } catch (cause) {
    const message = parseFailure(cause);
    if (message === undefined) throw cause;
    return { ok: false, message };
  }
}

/**
 * A failure carrying no diagnostic is the toolchain breaking, not the program,
 * and belongs on the rejection path. The line esbuild reports is against the
 * wrapped text, one ahead of the program the caller wrote.
 */
function parseFailure(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const [first] = (cause as Error & { errors?: readonly Message[] }).errors ?? [];
  if (first === undefined) return undefined;
  const at = first.location;
  return at === null ? first.text : `${first.text} (${at.line - 1}:${at.column + 1})`;
}
