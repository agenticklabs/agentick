/**
 * Wire-method augmentation — adds the `completions/complete` row to the spec
 * `WireMethods` seed.
 *
 * Split out from {@link ./augment.ts} (which registers the server bridge /
 * session / ctx slots) so a BROWSER bundle can type the verb without loading a
 * line of server code: the row is what makes `session.completions.complete(…)`
 * exist on the derived wire proxy, and the proxy is client-side. Pure type-only
 * augmentation, zero runtime.
 *
 * The `export {}` is load-bearing, not decoration. A file whose top level is only
 * `declare module "X"` is a SCRIPT, and a script's `declare module` SHADOWS
 * module X instead of augmenting it — every one of spec's exports would vanish
 * for every downstream consumer. The type-only import below already makes this a
 * module; the explicit marker keeps it one if that import ever goes away.
 *
 * @see docs/proposals/v2/completions.md §2.3
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { CompletionResult } from "@agentick/spec";

export {};

declare module "@agentick/spec" {
  interface WireMethods {
    /**
     * Complete one argument of one thing — the ONE generalized completion verb,
     * MCP-shaped on purpose so squaring up with `completion/complete` costs a
     * projection rather than a translation.
     *
     * `ref` is the discriminated opening. It carries exactly one arm today
     * (`"prompt"`); `"resource"` and `"tool"` are additive later and land as new
     * members of the union, not as a widened `string`. A typo in `ref.type` is
     * therefore a compile error at the call site.
     *
     * `context.arguments` is the sibling values already filled — the same nesting
     * MCP uses, carried verbatim rather than flattened, so the projection copies
     * the field.
     *
     * Answers a {@link CompletionResult}. An argument nobody can complete answers
     * `{ values: [] }` — completion never protocol-errors on an unknown argument
     * or an unbound source, only on an unknown PROMPT.
     */
    "completions/complete": {
      params: {
        sessionId: string;
        ref: { readonly type: "prompt"; readonly name: string };
        argument: { readonly name: string; readonly value: string };
        context?: { readonly arguments: Readonly<Record<string, string>> };
      };
      result: CompletionResult;
    };
  }
}
