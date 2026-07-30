/**
 * Per-argument completion — the record/sidecar split for
 * {@link PromptArgument.complete}, and the ONE definition of the derived-ref
 * grammar.
 *
 * A prompt argument completes in one of two ways (the ADR 42 dichotomy):
 *
 *   - an INLINE {@link CompletionResolver} — a function, so it takes the exact
 *     ride `render` takes: the {@link import("./harness.js").PromptsHarness}
 *     sidecar holds it, the store never sees it, and the record carries a
 *     `completeRef` naming it. The name is DERIVED here.
 *   - a NAMED REF into the completions registry — already a string, so it goes
 *     straight onto the record and there is nothing to side-car.
 *
 * A resolver from `defineCompletion(name, fn)` is both at once — a function with
 * a name — so it side-cars like the first and refs like the second, under the name
 * it already carries.
 *
 * `normalizePromptArguments` performs that split at every declaration-write site;
 * `restorePromptArguments` re-joins it on every read that hands out a full
 * declaration. The two are inverse, with one deliberate asymmetry: a DERIVED ref
 * whose sidecar entry is gone (post-`importSnapshot`) restores to no `complete`
 * at all rather than to a string pointing at nothing — the same honesty
 * `template`/`render` get, where a restored prompt has no content until the
 * adopter re-registers it.
 *
 * The resolve door itself is `PromptsHarness.complete` — it reads the re-joined
 * declaration, so the three shapes `restorePromptArguments` can hand back (a
 * function, a string, nothing) ARE the three arms of `PromptsCompleteOutcome`.
 * This file owns the grammar and the structural readers it needs; it runs
 * nothing.
 *
 * @see docs/proposals/v2/completions.md §2.1–§2.2, §4
 * @verifiedBy packages/prompts/src/__tests__/completion.spec.ts
 */

import type {
  CompletionResolver,
  CompletionResult,
  CompletionValues,
  PromptArgument,
  PromptArgumentRecord,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

/**
 * The prefix RESERVED for refs this package derives. A registry name starting
 * with it is read as a derived ref, so adopter-chosen names must not use it.
 */
const DERIVED_REF_PREFIX = "prompt:";

/**
 * THE derived-ref grammar — `prompt:<promptName>:<argName>`, defined here and
 * nowhere else.
 *
 * Stable across re-registration (it is a function of the two names only, never of
 * registration order or a ULID), and collision-free: two prompts cannot share a
 * name, an argument name is unique within its prompt, and the
 * {@link DERIVED_REF_PREFIX} keeps the space disjoint from adopter-chosen
 * registry names.
 *
 * Exported because it is an ADDRESSING grammar, like {@link
 * import("./projection.js").promptUri}: the P2 resolve door and any client that
 * asks the completions registry directly must compute the same string.
 */
export function promptCompletionRef(promptName: string, argName: string): string {
  return `${DERIVED_REF_PREFIX}${promptName}:${argName}`;
}

/** Was this ref derived by {@link promptCompletionRef} (vs. author-chosen)? */
export function isDerivedCompletionRef(ref: string): boolean {
  return ref.startsWith(DERIVED_REF_PREFIX);
}

/**
 * Read `completeDependent`'s `requires` metadata off a resolver — STRUCTURALLY.
 *
 * The canonical read door is `isDependentResolver` in `@agentick/completions`,
 * and this duplicates three lines of it on purpose: prompts declares no runtime
 * dependency on the completions harness (it holds resolvers, it does not run
 * them), exactly as it wires the `prompt://` resources projection with types
 * alone. Importing the guard would pull that package's four-interface module
 * augmentation and its `registerNamespaceSlot` side effect into every prompts
 * consumer, installing the completions namespace as a side effect of using
 * prompts. The frozen non-enumerable `requires: readonly string[]` is the
 * contract; `@agentick/completions` is a devDependency so a test pins the two
 * readings against each other.
 *
 * An empty `requires` declares no dependency, so it projects as `undefined`
 * rather than an empty array a consumer would have to special-case.
 */
function completeRequiresOf(resolver: CompletionResolver): readonly string[] | undefined {
  const requires: unknown = (resolver as { readonly requires?: unknown }).requires;
  if (!Array.isArray(requires) || requires.length === 0) return undefined;
  if (!requires.every((entry) => typeof entry === "string")) return undefined;
  return [...(requires as readonly string[])];
}

/**
 * The canonical registry name a `defineCompletion(name, resolver)` source
 * carries, read the same structural way as `requires` and for the same reason.
 *
 * A NAMED source handed straight to a `complete:` slot (the dual use its own doc
 * advertises) already HAS an address, so deriving a second one would alias one
 * resolver under two names — and the ref on the record would not be the name the
 * registry answers to.
 */
function completionNameOf(resolver: CompletionResolver): string | undefined {
  const name: unknown = (resolver as { readonly completionName?: unknown }).completionName;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * Fold a resolver's return value into the full {@link CompletionResult} — a bare
 * `readonly string[]` is sugar for `{ values }`.
 *
 * The canonical fold is `normalizeCompletionResult` in `@agentick/completions`,
 * and this duplicates three lines of it for the same reason
 * {@link completeRequiresOf} duplicates `isDependentResolver`: importing it would
 * pull that package's four-interface module augmentation and its
 * `registerNamespaceSlot` side effect into every prompts consumer, installing the
 * completions namespace as a side effect of using prompts. The two-shape return
 * contract lives in spec ({@link CompletionValues}), which is what both readings
 * are pinned against — and `@agentick/completions` is a devDependency, so a test
 * asserts the two folds agree.
 */
export function foldCompletionValues(raw: CompletionValues): CompletionResult {
  return Array.isArray(raw) ? { values: raw } : (raw as CompletionResult);
}

/** The two halves {@link normalizePromptArguments} splits a declaration into. */
export interface NormalizedPromptArguments {
  /** Record-safe descriptors for the store. `undefined` iff the prompt declares none. */
  readonly records?: readonly PromptArgumentRecord[];
  /** Inline resolvers, keyed by ARGUMENT name. `undefined` when no argument has one. */
  readonly completions?: Readonly<Record<string, CompletionResolver>>;
}

/**
 * Split declared arguments into the record-safe slice and the resolver sidecar.
 *
 * `complete` is destructured OFF every descriptor rather than merely typed away:
 * `prompts:register` is a wire-exposed command, so an inbound payload can carry
 * the key regardless of what the type says, and the durability guarantee has to
 * hold at runtime too.
 */
export function normalizePromptArguments(
  promptName: string,
  args: readonly PromptArgument[] | undefined,
): NormalizedPromptArguments {
  if (args === undefined) return {};
  const completions: Record<string, CompletionResolver> = {};
  const records = args.map((arg): PromptArgumentRecord => {
    const { complete, ...rest } = arg;
    if (typeof complete === "string") {
      // A named ref is already record-safe. `completeRequires` stays undefined:
      // the registry owns the resolver's dependencies (P2 enumeration projects
      // them), and copying them here would be a second source of truth.
      return { ...rest, completeRef: complete };
    }
    if (typeof complete === "function") {
      // Its own name if it has one, else derived. Either way the function goes to
      // the sidecar: the P2 resolve door reads the sidecar first, so an inline
      // source works whether or not it is also listed in the registry.
      const ref = completionNameOf(complete) ?? promptCompletionRef(promptName, arg.name);
      completions[arg.name] = complete;
      return {
        ...rest,
        completeRef: ref,
        ...omitUndefined({ completeRequires: completeRequiresOf(complete) }),
      };
    }
    return rest;
  });
  return {
    records,
    ...(Object.keys(completions).length > 0 ? { completions } : {}),
  };
}

/**
 * Re-join the split: record-safe descriptors + the resolver sidecar → the
 * author's shape. The projectable `completeRef` / `completeRequires` stay on the
 * result — they are the metadata a palette reads, and dropping them would make a
 * sidecar-less (restored) declaration carry MORE than a live one.
 */
export function restorePromptArguments(
  records: readonly PromptArgumentRecord[] | undefined,
  completions: Readonly<Record<string, CompletionResolver>> | undefined,
): readonly PromptArgument[] | undefined {
  if (records === undefined) return undefined;
  return records.map((record): PromptArgument => {
    const resolver = completions?.[record.name];
    if (resolver !== undefined) return { ...record, complete: resolver };
    if (record.completeRef !== undefined && !isDerivedCompletionRef(record.completeRef)) {
      return { ...record, complete: record.completeRef };
    }
    // Derived ref, no sidecar: the function did not survive (a fresh session, a
    // restored snapshot). Same silence `render` keeps rather than handing back a
    // ref nothing answers to.
    return record;
  });
}
