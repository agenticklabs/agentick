/**
 * The README's examples, compiled. The house rule is that a README example must
 * typecheck against the CURRENT exports, and `tsc -p tsconfig.json` covers this
 * directory — so this file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile. A `vitest` stub keeps the file a
 * legitimate spec rather than a dead module.
 */

import { describe, it } from "vitest";

import {
  composeHydrators,
  definePrompts,
  hydrateFrom,
  hydrateFromModule,
  hydrateFromStaticUrl,
  hydrateFromStore,
  InMemoryPromptStore,
  matchesPromptQuery,
  promptUri,
  withPrompts,
  type PromptRenderer,
} from "../index.js";

const fixtures = [{ declaration: { name: "fixture", description: "f", template: "t" } }] as const;

// ── Quick start
withPrompts({
  hydrate: hydrateFrom([
    {
      declaration: {
        name: "summarize_doc",
        description: "Summarize a document by id.",
        arguments: [{ name: "docId", required: true }],
        render: (args) => `Summarize the document at ${String(args.docId)}.`,
      },
    },
  ]),
});

// ── The per-caller render signature
definePrompts({
  hydrate: hydrateFrom([
    {
      declaration: {
        name: "greet",
        description: "g",
        render: (_args, ctx) => `Hello ${ctx?.principal ?? "there"}.`,
      },
    },
  ]),
});

// ── Sources
withPrompts({
  hydrate: composeHydrators(
    hydrateFromModule({ specifier: "./prompts/index.js" }),
    hydrateFromStaticUrl({ url: "https://registry.internal/prompts.json" }),
  ),
});

withPrompts({
  hydrate: (ctx) => Promise.resolve(ctx.principal === undefined ? [] : [...fixtures]),
});

// ── The plan, and overriding one slot of it
const production = definePrompts({
  store: new InMemoryPromptStore(),
  hydrate: hydrateFromModule({ specifier: "./prompts/index.js" }),
  guards: { invoke: (input) => (input.name === "blocked" ? { kind: "veto" } : undefined) },
});
definePrompts({ ...production, hydrate: hydrateFrom([...fixtures]) });

// ── Policy on the plan
definePrompts({
  hooks: { onAfterRender: (result) => ({ ...result, messages: result.messages }) },
  guards: {
    invoke: (input) => (input.name === "blocked" ? { kind: "veto", reason: "blocked" } : undefined),
  },
});

// ── Store backing, and putting the code back on top of the durable slice
withPrompts({
  store: new InMemoryPromptStore(),
  hydrate: composeHydrators(
    hydrateFromStore(),
    hydrateFromModule({ specifier: "./prompts/index.js" }),
  ),
});

// ── Authoring a renderer
const myRenderer: PromptRenderer = {
  name: "my-format",
  handles: (content) => typeof content === "number",
  async render(content) {
    return [{ kind: "message", role: "user", content: [{ type: "text", text: String(content) }] }];
  },
};
withPrompts({ renderers: [myRenderer] });

// ── The live-library arm
// A stand-in for the adopter-owned instance; the compile is the point.
const mySharedPrompts = {} as import("@agentick/spec").Prompts;
withPrompts(mySharedPrompts);

// ── Misc exports the README names
promptUri("weekly_status");
matchesPromptQuery({ name: "x", description: "d" }, { name: "x" });

describe("README examples", () => {
  it("compile against the current exports", () => {});
});
