/**
 * `definePrompt` (singular) — identity + INFERENCE for one prompt declaration.
 *
 * ## Identity, inference, and erasure
 *
 * At runtime it returns its argument. In the type, the argument list narrows
 * `render`'s `args` and the RESULT is the plain `PromptDeclaration` the harness
 * consumes — see {@link definePrompt} for why the narrowing cannot survive into
 * the return type and what the claim is actually worth.
 *
 * ## No brand, unlike `definePrompts`
 *
 * A brand exists to DISCRIMINATE, and nothing discriminates a single
 * declaration: it never arrives on its own at a slot that could mistake it for
 * something else. It arrives inside a seed list (`hydrateFrom([{ declaration }])`)
 * or as a module's default export collected through a barrel
 * (`hydrateFromModule`) — both positions already typed as declarations. So this
 * function returns its argument unchanged, and its whole value is what it does to
 * the TYPE.
 *
 * ## What it buys — `render(args)` typed from the argument list
 *
 * ```ts
 * export default definePrompt({
 *   name: "tm_change_order_actual_cost",
 *   description: "Log an actual cost against a change order.",
 *   arguments: [
 *     { name: "job", required: true, complete: completeFromAsync(searchJobs) },
 *     { name: "markup_pct", complete: completeFromList(["10", "15", "20"]) },
 *   ],
 *   render: (args) => `Job ${args.job} at ${args.markup_pct ?? "default"} markup.`,
 *   //                        ^ string        ^ string | undefined
 * });
 * ```
 *
 * **LAW (completions.md §2.1): no schema → the arg is a `string`.** That is MCP
 * parity — `prompts/get` arguments arrive as strings off the wire, and pretending
 * otherwise would make a declaration that typechecks and then fails at
 * invocation. Want a number, declare a `schema`, and `render` sees its inferred
 * output. Undeclared keys are not part of the inferred type: the harness passes
 * extra args through at runtime, but a declaration that reads one it never
 * declared is a bug this refuses to spell.
 *
 * @see docs/proposals/v2/completions.md §2.1
 * @verifiedBy packages/prompts/src/__tests__/define-prompt.type.spec.ts
 * @verifiedBy packages/prompts/src/__tests__/completion.spec.ts
 */

import type {
  InferOutput,
  OperationCtx,
  PromptArgument,
  PromptDeclaration,
  StandardSchemaV1,
} from "@agentick/spec";

/**
 * The value one declared argument yields to `render` — its schema's inferred
 * output when it declares one, `string` when it does not (the LAW above).
 */
type PromptArgValue<A extends PromptArgument> = A extends { readonly schema: infer S }
  ? S extends StandardSchemaV1
    ? InferOutput<S>
    : string
  : string;

/**
 * The `args` object `render` receives, derived from the declared argument tuple:
 * one key per argument, `required: true` → the value, everything else → the value
 * `| undefined`.
 *
 * Optionality is expressed in the VALUE rather than as a `?` key so a render
 * destructuring every argument at once compiles; the union is what the harness
 * actually hands over, since an omitted optional arg is simply an absent key.
 */
export type PromptArgs<A extends readonly PromptArgument[]> = {
  readonly [K in A[number] as K["name"]]: K extends { readonly required: true }
    ? PromptArgValue<K>
    : PromptArgValue<K> | undefined;
};

/**
 * The AUTHORING shape — a {@link PromptDeclaration} whose `arguments` are pinned
 * to the literal tuple `A` and whose `render` is typed from it. It is the
 * parameter type only; {@link definePrompt} hands back the erased
 * `PromptDeclaration`.
 */
export interface TypedPromptDeclaration<A extends readonly PromptArgument[]> extends Omit<
  PromptDeclaration,
  "arguments" | "render"
> {
  /** The declared argument tuple, pinned by the `const` type parameter. */
  readonly arguments?: A;
  /** Dynamic content, with `args` typed from {@link arguments}. */
  readonly render?: (args: PromptArgs<A>, ctx?: OperationCtx) => unknown;
}

/**
 * Name one prompt. Returns its argument unchanged at runtime; in the type, the
 * narrowing lives on the PARAMETER and the result is the plain
 * {@link PromptDeclaration} the harness consumes.
 *
 * That erasure is the `createTool` precedent (`ToolSpec<TInput>` in, erased
 * `ToolDeclaration` out) and it is forced rather than chosen: a `render` narrowed
 * to `PromptArgs<A>` is a strictly-narrower callback than
 * `PromptDeclaration.render`, so the authoring type cannot be assignable to the
 * declaration under `strictFunctionTypes` — the cast is where the narrowing is
 * paid for, once, here, instead of at every seed list.
 *
 * **What the narrowing is worth, exactly.** `args.job: string` is a claim about
 * the WIRE (MCP prompt arguments are strings) and about the harness's validated
 * output — not a runtime guarantee: an argument with no `schema` is passed through
 * unvalidated, so an in-process caller handing `invoke` a number puts a number
 * there. Declare a `schema` when the value must be checked; that is the same
 * trade the LAW in the file doc names.
 *
 * The default `readonly []` is what makes an argument-less prompt infer honestly:
 * with no `arguments` property there is no inference site, so `A` falls to the
 * empty tuple and `render` receives an args object with no known keys — rather
 * than the constraint's index signature, which would invent `string` values for
 * keys the prompt never declared.
 */
export function definePrompt<const A extends readonly PromptArgument[] = readonly []>(
  declaration: TypedPromptDeclaration<A>,
): PromptDeclaration {
  return declaration as PromptDeclaration;
}
