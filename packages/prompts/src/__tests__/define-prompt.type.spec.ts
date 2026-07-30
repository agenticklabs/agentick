/**
 * TYPE-LEVEL conformance for {@link definePrompt}. The whole value of the factory
 * is what it does to the type of `render`'s `args`, so these assertions ARE the
 * feature — a regression here is invisible to every runtime test in the package.
 *
 * Pins:
 *   - `required: true` → the value; anything else → the value `| undefined`;
 *   - no `schema` → `string` (the completions.md §2.1 LAW, MCP parity);
 *   - `schema` present → its inferred output;
 *   - a declaration with NO arguments → an args object with no keys (not the
 *     constraint's index signature);
 *   - undeclared keys are not readable;
 *   - the result IS `PromptDeclaration` — the narrowing lives on the parameter and
 *     is erased on the way out, so the harness consumes the declaration unchanged;
 *   - `complete` takes BOTH forms of the dichotomy: an inline resolver and a
 *     named registry ref.
 *
 * @see docs/proposals/v2/completions.md §2.1
 */

import { describe, expectTypeOf, it } from "vitest";
import { completeDependent, completeFromAsync, completeFromList } from "@agentick/completions";
import type {
  CompletionResolver,
  PromptArgument,
  PromptDeclaration,
  StandardSchemaV1,
} from "@agentick/spec";

import { definePrompt, type PromptArgs } from "../define-prompt.js";

/** A minimal Standard Schema whose output is `number` — no validator dependency. */
const numberSchema: StandardSchemaV1<unknown, number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: Number(value) }),
  },
};

describe("definePrompt — argument inference", () => {
  it("types required as the value and optional as value | undefined", () => {
    const prompt = definePrompt({
      name: "tm_change_order_actual_cost",
      description: "Log an actual cost against a change order.",
      arguments: [
        { name: "job", required: true },
        { name: "phase", required: true },
        { name: "markup_pct", required: false },
        { name: "note" },
      ],
      render: (args) => {
        expectTypeOf(args.job).toEqualTypeOf<string>();
        expectTypeOf(args.phase).toEqualTypeOf<string>();
        expectTypeOf(args.markup_pct).toEqualTypeOf<string | undefined>();
        // `required` omitted is the same statement as `required: false`.
        expectTypeOf(args.note).toEqualTypeOf<string | undefined>();
        return "";
      },
    });
    expectTypeOf(prompt.arguments).not.toBeUndefined();
  });

  it("uses the schema's inferred output when an argument declares one", () => {
    definePrompt({
      name: "page",
      description: "A paginated thing.",
      arguments: [
        { name: "limit", required: true, schema: numberSchema },
        { name: "cursor", schema: numberSchema },
      ],
      render: (args) => {
        expectTypeOf(args.limit).toEqualTypeOf<number>();
        expectTypeOf(args.cursor).toEqualTypeOf<number | undefined>();
        return "";
      },
    });
  });

  it("declares no keys for a prompt with no arguments", () => {
    definePrompt({
      name: "catch_me_up",
      description: "Summarize the conversation.",
      render: (args) => {
        expectTypeOf(args).toEqualTypeOf<PromptArgs<readonly []>>();
        expectTypeOf<keyof typeof args>().toEqualTypeOf<never>();
        return "";
      },
    });
  });

  it("does not spell keys the declaration never declared", () => {
    definePrompt({
      name: "greet",
      description: "Greet.",
      arguments: [{ name: "who", required: true }],
      render: (args) => {
        // @ts-expect-error — `when` is not a declared argument.
        void args.when;
        return "";
      },
    });
  });

  it("threads the invoking crossing's OperationCtx as the second parameter", () => {
    definePrompt({
      name: "greet",
      description: "Greet.",
      arguments: [{ name: "who", required: true }],
      render: (args, ctx) => `Hello ${args.who}, from ${ctx?.sessionId ?? "nowhere"}.`,
    });
  });
});

describe("definePrompt — assignability", () => {
  it("hands back the erased PromptDeclaration the harness consumes", () => {
    const prompt = definePrompt({
      name: "greet",
      description: "Greet.",
      arguments: [{ name: "who", required: true }],
      render: (args) => `Hello ${args.who}.`,
    });
    expectTypeOf(prompt).toEqualTypeOf<PromptDeclaration>();
    // The declaration position it actually lands in — a seed list's `declaration`.
    const seeds: readonly { readonly declaration: PromptDeclaration }[] = [{ declaration: prompt }];
    expectTypeOf(seeds).not.toBeNever();
  });

  it("an argument-less declaration is assignable too", () => {
    expectTypeOf(
      definePrompt({ name: "static", description: "d", template: "t" }),
    ).toEqualTypeOf<PromptDeclaration>();
  });
});

describe("definePrompt — the complete dichotomy", () => {
  it("accepts an inline resolver and a named registry ref on the same declaration", () => {
    definePrompt({
      name: "tm_change_order_actual_cost",
      description: "Log an actual cost against a change order.",
      arguments: [
        {
          name: "job",
          required: true,
          complete: completeFromAsync(async (value) => [`job:${value}`]),
        },
        {
          name: "phase",
          required: true,
          complete: completeDependent({ requires: ["job"] }, (value, { job }) => [
            `${job}:${value}`,
          ]),
        },
        { name: "markup_pct", complete: completeFromList(["10", "15", "20"]) },
        // The reusable form — a string crosses the spec firewall, a function never does.
        { name: "cost_code", complete: "knowify.cost_codes" },
      ],
      render: (args) => {
        // A `complete` resolver does not change what `render` sees — the value is
        // still typed by `required` + `schema` alone.
        expectTypeOf(args.job).toEqualTypeOf<string>();
        expectTypeOf(args.markup_pct).toEqualTypeOf<string | undefined>();
        expectTypeOf(args.cost_code).toEqualTypeOf<string | undefined>();
        return "";
      },
    });
    // Both forms live in the SAME slot — one union, not two fields.
    expectTypeOf<PromptArgument["complete"]>().toEqualTypeOf<
      CompletionResolver | string | undefined
    >();
  });

  it("rejects a non-resolver, non-string in the complete slot", () => {
    definePrompt({
      name: "greet",
      description: "Greet.",
      // @ts-expect-error — `complete` is a resolver or a registry name, not a list.
      arguments: [{ name: "who", required: true, complete: ["a", "b"] }],
    });
  });
});
