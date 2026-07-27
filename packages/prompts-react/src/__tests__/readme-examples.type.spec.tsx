/**
 * The README's examples, compiled. A README example must typecheck against the
 * CURRENT exports, and `tsc -p tsconfig.json` covers this directory — so this
 * file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile.
 */

import React from "react";
import { describe, it } from "vitest";

import { Section, System, User } from "@agentick/compiler-react";
import { definePrompts, hydrateFrom, withPrompts } from "@agentick/prompts";

import { createReactPromptRenderer, reactPromptRenderer, withReactPrompts } from "../index.js";

// ── Quick start: the pre-baked React extension takes the same options
withReactPrompts({
  hydrate: hydrateFrom([
    {
      declaration: {
        name: "weekly_status",
        description: "Draft the weekly status report",
        arguments: [
          { name: "week", required: true },
          { name: "team", required: false },
        ],
        render: (args) => (
          <>
            <System>You write terse, factual status reports.</System>
            <Section id="format" title="Format">
              Three sections, in order: Shipped, In flight, Blocked.
            </Section>
            <User>
              Draft the report for week {String(args.week)}
              {args.team ? ` (team: ${String(args.team)})` : ""}.
            </User>
          </>
        ),
      },
    },
  ]),
});

// ── Every other option forwards
withReactPrompts({
  hydrate: hydrateFrom([]),
  exposeAsResources: false,
  extraRenderers: [reactPromptRenderer],
  hooks: { onBeforeRegister: (input) => input },
  guards: { invoke: () => undefined },
});

// ── Composing renderers with the core extension
withPrompts({ renderers: [reactPromptRenderer] });

const narrowed = createReactPromptRenderer({
  handles: (content) => typeof content === "object" && content !== null && "$$typeof" in content,
  compile: { maxIterations: 20 },
});
withPrompts({ renderers: [narrowed] });

// ── A named plan carrying the React renderer
definePrompts({ renderers: [reactPromptRenderer], hydrate: hydrateFrom([]) });

describe("README examples", () => {
  it("compile against the current exports", () => {});
});
