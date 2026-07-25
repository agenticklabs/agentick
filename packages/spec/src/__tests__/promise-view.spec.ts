/**
 * `PromiseView` — JSDoc-preservation regression guard.
 *
 * The dual-typed edge (ADR 77) authors each operation's doc ONCE, on the
 * `Fx` twin; the derived Promise surface (`PromiseView<Fx>`) inherits it
 * because a homomorphic mapped type preserves per-member JSDoc. That
 * preservation is invisible to `tsc` — a non-homomorphic rewrite of
 * `PromiseView` still typechecks, every suite stays green, and only the
 * editor hover goes blank. This test is the sole guard: it drives the
 * TypeScript language service against the REAL `PromiseView` and asserts
 * a sentinel doc survives the mapping.
 *
 * @see ../protocol/promise-view.ts — the "keep this homomorphic" invariant.
 */

import { describe, expect, it } from "vitest";
// TS7's native compiler exposes no programmatic API (language service et al.)
// until 7.1 — API consumers ride the sanctioned `@typescript/typescript6`
// compatibility package (the same hybrid Microsoft prescribes for TypeDoc).
// This is the workspace's ONLY compiler-API consumer outside the website.
import ts from "@typescript/typescript6";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTINEL = "SENTINEL_DOC_9f3a — set the knob through runOperation.";

const PROBE_PATH = resolve(HERE, "__promise_view_probe__.ts");

/**
 * Drive the TS language service against `source` (served from memory at a
 * path inside this package, so its relative `promise-view.js` import and
 * its `effect` import both resolve on disk — we exercise the SHIPPED type,
 * not a copy) and return the quick-info for the `probe.<member>` hover:
 * the rendered `signature` and the `doc` string.
 */
function quickInfo(source: string, member: string): { signature: string; doc: string } {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [PROBE_PATH],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) =>
      f === PROBE_PATH
        ? ts.ScriptSnapshot.fromString(source)
        : ts.sys.fileExists(f)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? "")
          : undefined,
    getCurrentDirectory: () => HERE,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const pos = source.lastIndexOf(`probe.${member}`) + `probe.`.length + 1; // land inside the name
  const info = svc.getQuickInfoAtPosition(PROBE_PATH, pos);
  return {
    signature: info?.displayParts?.map((p) => p.text).join("") ?? "",
    doc: ts.displayPartsToString(info?.documentation ?? []),
  };
}

const PROBE = (docComment: string) => `
import type { PromiseView } from "../protocol/promise-view.js";
import type { Effect } from "effect";
interface Fx {
  ${docComment}
  set(input: { readonly id: string }): Effect.Effect<void, Error, never>;
}
declare const probe: PromiseView<Fx>;
probe.set;
`;

describe("PromiseView — JSDoc preservation", () => {
  it("carries the Fx twin's doc onto the derived Promise method", () => {
    // THE guard — the property invisible to `tsc`. A non-homomorphic rewrite
    // of PromiseView keeps the type mapping but silently drops this doc.
    const { doc } = quickInfo(PROBE(`/** ${SENTINEL} */`), "set");
    expect(doc).toContain(SENTINEL);
  });

  it("rewrites the Effect return to its awaited Promise form", () => {
    // Sanity: the mapping actually fires (not a pass-through). Guards against
    // PromiseView being gutted to identity, which would trivially "preserve"
    // docs while doing nothing.
    const { signature } = quickInfo(PROBE(""), "set");
    expect(signature).toContain("Promise<void>");
    expect(signature).not.toContain("Effect");
  });
});
