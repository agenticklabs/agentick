/**
 * The README's examples, compiled. The house rule is that a README example must
 * typecheck against the CURRENT exports, and `tsc -p tsconfig.json` covers this
 * directory — so this file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile.
 */

import { describe, it } from "vitest";

import {
  composeHydrators,
  defaultComposeRun,
  defineSkills,
  hydrateFrom,
  hydrateFromManifest,
  hydrateFromStore,
  hydrateFromUrl,
  InMemorySkillStore,
  matchesSkillQuery,
  skillBodyUri,
  withSkills,
} from "../index.js";
import {
  hydrateFromDirectory,
  hydrateFromFile,
  hydrateFromMarkdownFiles,
} from "../hydrators-node.js";

const fixtures = [{ name: "fixture", description: "f", content: "c" }] as const;
const myDurableStore = new InMemorySkillStore();
const parseYaml = (text: string): Record<string, unknown> => ({ raw: text });

// ── Quick start
withSkills({
  hydrate: hydrateFrom([
    {
      name: "weekly_status_report",
      description: "Template for the Monday morning status update.",
      content: "## Last week\n…\n## This week\n…\n## Blockers\n…",
      tags: ["reporting", "weekly"],
    },
  ]),
});

// ── Where skills come from
withSkills({
  hydrate: composeHydrators(
    hydrateFromDirectory({ root: "./.agents/skills/" }),
    hydrateFromFile({ path: "./extra.md" }),
    hydrateFromUrl({ url: "https://registry.internal/skills.json" }),
  ),
});

withSkills({ hydrate: (ctx) => Promise.resolve(ctx.principal === undefined ? [] : [...fixtures]) });

withSkills({
  store: myDurableStore,
  hydrate: composeHydrators(
    hydrateFromStore(),
    hydrateFromDirectory({ root: "./.agents/skills/" }),
  ),
});

hydrateFromDirectory({ root: "./.agents/skills/", parseFrontmatter: parseYaml });
hydrateFromMarkdownFiles({ path: "./skills/" });
hydrateFromManifest({ url: "https://registry.internal/skills.json" });

// ── Configuring the slot
withSkills({ store: myDurableStore, hydrate: hydrateFromDirectory({ root: "./.agents/skills/" }) });

// A stand-in for the adopter-owned instance; the compile is the point.
const mySharedSkills = {} as import("@agentick/spec").Skills;
withSkills(mySharedSkills);

const production = defineSkills({
  store: myDurableStore,
  hydrate: hydrateFromDirectory({ root: "./.agents/skills/" }),
  guards: { register: (input) => (input.name.startsWith("_") ? { kind: "veto" } : undefined) },
});
defineSkills({ ...production, hydrate: hydrateFrom([...fixtures]) });

// ── Policy on the plan
defineSkills({
  hooks: { onBeforeRegister: (input) => ({ ...input, name: input.name.toLowerCase() }) },
  guards: {
    register: (input) =>
      input.name === "reserved" ? { kind: "veto", reason: "reserved" } : undefined,
  },
});

// ── Owning composition
withSkills({
  composeRun: (skill, opts) => ({
    messages: [
      { role: "system", content: `# ${skill.name}\n\n${skill.content}` },
      { role: "user", content: JSON.stringify(opts.args ?? {}) },
    ],
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
  }),
});

// ── Store backing + misc exports the README names
withSkills({ store: new InMemorySkillStore() });
skillBodyUri("code_review");
matchesSkillQuery(
  { name: "x", description: "d", content: "c", createdAt: 0, updatedAt: 0 },
  { query: "x" },
);
void defaultComposeRun;

describe("README examples", () => {
  it("compile against the current exports", () => {});
});
