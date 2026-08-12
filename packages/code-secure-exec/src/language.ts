/**
 * What source the isolate accepts, and what it does to it before compilation.
 *
 * TypeScript is a MODE, not a second provider: JavaScript is valid TypeScript,
 * so a TS-mode isolate accepts every program a JS-mode one does and only erases
 * types on the way. The erasure is TRANSPILE-ONLY — esbuild strips types
 * without checking them; a type error reaches the engine at runtime. Type
 * CHECKING is a policy seam (`guard({ codeExecute })`).
 *
 * A program is an async-function BODY. It is wrapped so that a program-level
 * throw is caught INSIDE the isolate and returned as data (`outcome: "threw"`),
 * never as a host-side rejection — that is what lets `execute` read a rejection
 * from `script.run` as unambiguously a budget/abort/engine failure.
 */

import { transform, type Message } from "esbuild";

export type IsolateLanguage = "javascript" | "typescript";

export type Compiled =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly message: string };

const OPEN = "(async()=>{try{const __agentick_value=await (async()=>{\n";
const CLOSE =
  "\n})();" +
  "return __agentick_value===undefined" +
  '?{outcome:"no-value"}' +
  ':{outcome:"returned",value:__agentick_value};' +
  "}catch(__agentick_error){" +
  'return{outcome:"threw",error:{' +
  "name:__agentick_error==null?void 0:__agentick_error.name," +
  "message:__agentick_error!=null&&__agentick_error.message!=null" +
  "?String(__agentick_error.message):String(__agentick_error)," +
  "stack:__agentick_error==null?void 0:__agentick_error.stack" +
  "}};}})();";

function harnessed(source: string): string {
  return `${OPEN}${source}${CLOSE}`;
}

export function compiler(language: IsolateLanguage): (source: string) => Promise<Compiled> {
  if (language === "javascript") {
    return (source) => Promise.resolve({ ok: true, source: harnessed(source) });
  }
  return stripTypes;
}

async function stripTypes(source: string): Promise<Compiled> {
  try {
    const { code } = await transform(harnessed(source), { loader: "ts" });
    return { ok: true, source: code };
  } catch (cause) {
    const message = parseFailure(cause);
    if (message === undefined) throw cause;
    return { ok: false, message };
  }
}

/**
 * A failure carrying no diagnostic is the toolchain breaking, not the program.
 * The line esbuild reports is against the wrapped text, one ahead of the body
 * the caller wrote.
 */
function parseFailure(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const [first] = (cause as Error & { errors?: readonly Message[] }).errors ?? [];
  if (first === undefined) return undefined;
  const at = first.location;
  return at === null ? first.text : `${first.text} (${at.line - 1}:${at.column + 1})`;
}
