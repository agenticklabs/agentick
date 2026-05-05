# Skills

A **skill** is a callable agent specialization: a workflow defined by instructions, an input contract, and an optional set of allowed tools. Skills package procedural knowledge into portable, version-controlled folders that any skills-compatible agent can load.

Agentick implements the [Agent Skills](https://agentskills.io) open standard — the cross-tool format adopted by Claude Code, Cursor, OpenAI Codex, Goose, Gemini CLI, and others — plus the Claude Code extensions for substitution and dynamic context injection. A `SKILL.md` file written for any of those tools drops in and works.

## Two execution models

Skills can be invoked two ways. They share file format and registry; they differ in _what happens_ when the skill is invoked.

### Load into context

The spec model. The skill body is added to the agent's current conversation as a tool result. The agent reads the new instructions and continues with them in scope. No sub-execution, no isolation.

This is what happens when the model calls the implicit `skill` tool. It's progressive disclosure stage 2: descriptions live in the tool's listing (cheap, always loaded), full bodies arrive only when activated.

### Sub-execution with typed result

The Agentick extension. The host calls `session.skill(skill, { args, result })`. The skill runs as a focused sub-task with a transient `submit` tool whose input schema is the caller's `result` schema. The model fills `submit` with a typed value; the host gets that value back, validated.

Same skill file works for both paths. The model door uses the loaded body; the host door wraps the body in a sub-execution with structured I/O.

## File format

A skill is a directory containing `SKILL.md`:

```
my-skill/
├── SKILL.md          # required: metadata + instructions
├── scripts/          # optional: executable code
├── references/       # optional: documentation loaded on demand
├── assets/           # optional: templates, images, data files
└── ...               # any other files
```

`SKILL.md` is YAML frontmatter followed by Markdown body:

```markdown
---
name: triage
description: Investigate an issue and decide on an action.
when_to_use: When the user reports a bug or asks to triage an issue.
allowed-tools: [search, read_file]
arguments: [issueNumber]
---

You are a triage agent.

Investigate issue $issueNumber using the search and read_file tools, then
decide whether a fix should be applied. When you have your answer, call
`submit` with the typed result.
```

### Frontmatter — Agent Skills core (open spec)

| Field           | Required | Notes                                                                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | 1–64 chars, lowercase alphanumeric + hyphens, no leading/trailing or consecutive hyphens. Must match the parent directory name. |
| `description`   | Yes      | ≤1024 chars. What the skill does and when to use it.                                                                            |
| `license`       | No       | License name or reference (e.g. `Apache-2.0`).                                                                                  |
| `compatibility` | No       | ≤500 chars. Environment requirements.                                                                                           |
| `metadata`      | No       | `Record<string, string>` for arbitrary key/value extras.                                                                        |
| `allowed-tools` | No       | Tool names the skill is allowed to use. Space-separated string or YAML list.                                                    |

### Frontmatter — Claude Code extensions

| Field                      | Notes                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when_to_use`              | Trigger phrases / example prompts. Helps the model decide when to apply the skill.                                                                        |
| `argument-hint`            | Autocomplete hint, e.g. `"[issueNumber]"`.                                                                                                                |
| `arguments`                | Names of positional arguments. Drives `$N` and `$name` substitution. String or YAML list.                                                                 |
| `disable-model-invocation` | When `true`, model can't auto-invoke; only programmatic / explicit user invocation. _Captured; full enforcement coming with the registry's gating layer._ |
| `user-invocable`           | When `false`, hidden from user-facing listings. _Captured; enforcement future._                                                                           |

### Frontmatter — Agentick extensions

| Field      | Notes                                           |
| ---------- | ----------------------------------------------- |
| `maxTicks` | Loop budget for sub-execution path. Default 10. |

### Reserved (parsed by spec, not yet acted on)

`model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell` — known fields from the Claude Code extended spec. Captured in the file but currently no-op at runtime. See the TODO header in `packages/core/src/skill/skill.ts` for the implementation phases.

## Programmatic skills with `defineSkill`

For skills authored in TypeScript (typed input from a Zod schema, no file loading):

```tsx
import { z } from "zod";
import { defineSkill } from "@agentick/core";

const Triage = defineSkill({
  name: "triage",
  description: "Investigate an issue and decide on action",
  instructions: "You are a triage agent. Investigate, decide, submit.",
  input: z.object({ issueNumber: z.number() }),
  allowedTools: ["search", "read_file"],
  argumentNames: ["issueNumber"],
});
```

`defineSkill` validates the same rules the loader does — name format, description length, metadata-must-be-strings — so you get spec compliance everywhere.

## Loading skills from files

```tsx
import { loadSkill } from "@agentick/core";

// Folder-based (canonical, full spec validation)
const Triage = await loadSkill("./skills/triage");
// reads ./skills/triage/SKILL.md

// Optional: opt into typed args via the loader
const TypedTriage = await loadSkill("./skills/triage", {
  input: z.object({ issueNumber: z.number() }),
});
```

`loadSkill` accepts a directory path (the spec form) or a `.md` file (Agentick convenience for tests / single-file skills). Folder mode is **strict**: `name` must match the parent directory, `description` is required. Flat-file mode is **lenient** — description is synthesized from the body's first non-empty line if missing.

For in-memory parsing (skills served from databases, network, etc.):

```tsx
import { parseSkill } from "@agentick/core";
const skill = parseSkill(markdownString);
```

## The `app.skills` registry

Apps own a skill registry. Sessions consult it to resolve string-name lookups and to expose skills to the model.

```tsx
import { createApp, loadSkill } from "@agentick/core";

const app = createApp(MyAgent);

// Register skills programmatically
app.skills.register(Triage);

// Or load every SKILL.md folder under a directory
await app.skills.loadDir("./skills");
```

### Discovery and search

```tsx
// Lookup by name
const triage = app.skills.get("triage");

// All registered
const all = app.skills.list();

// Substring across name, description, when_to_use, metadata values
const matches = app.skills.search({ query: "issue" });

// Metadata filters (AND semantics)
const owned = app.skills.search({
  metadata: { author: "alice" },
});

// Combine
const triageByAlice = app.skills.search({
  query: "triage",
  metadata: { author: "alice" },
});

// React to registry changes
const unsub = app.skills.subscribe((skills) => {
  console.log(
    "skills changed:",
    skills.map((s) => s.name),
  );
});
```

## Invoking skills

### From host code: `session.skill(name | def, opts)`

Programmatic, sub-execution, optionally with a typed result schema.

```tsx
// Resolve by name from app.skills
const result = await session.skill("triage", {
  args: { issueNumber: 42 },
  result: z.object({ fixApplied: z.boolean() }),
});
// result is typed { fixApplied: boolean }

// Or pass a SkillDef directly
const r2 = await session.skill(Triage, {
  args: { issueNumber: 42 },
  result: z.object({ severity: z.enum(["low", "high"]) }),
});
```

The same skill can be invoked by different callers with different result shapes. The skill defines the workflow; the caller decides what shape they want back.

Without `result`, the skill returns the model's final assistant text:

```tsx
const text = await session.skill("summarize", {
  args: { content: longText },
});
// text: string
```

The sub-execution loops with the skill's allowed tools and a transient `submit` tool whose input schema is your `result`. When the model calls submit, the args are validated against `result` and returned. Throws if `submit` isn't called within `maxTicks`.

### From the model: implicit `skill` tool

When `app.skills` has any registered skills, the session automatically exposes a `skill` tool. The model invokes it like any other tool:

```json
{ "tool": "skill", "input": { "name": "triage", "args": { "issueNumber": 42 } } }
```

The tool's description dynamically lists every registered skill with its description (truncated at ~8KB), so the model knows what's available — this is stage-1 progressive disclosure. The handler renders the skill body (with `$` substitution and `!` shell injection applied) and returns the rendered text as the tool result. The model then continues its current conversation with the skill's instructions in scope.

This is the **load-into-context** model — no sub-execution. The agent reads the new instructions and acts on them with its full conversation context, memory, and tools.

## Substitution

Skill bodies can reference args and environment variables. Syntax follows the Claude Code spec.

| Placeholder            | Resolves to                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `$ARGUMENTS`           | All args. JSON-stringified if object; raw string if string.                                |
| `$ARGUMENTS[N]` / `$N` | 0-indexed positional. From `argumentNames` (object args) or shell-tokenized (string args). |
| `$name`                | Named — looked up via `argumentNames` order or args object keys.                           |
| `${VAR}`               | Environment-style. Currently provided: `${AGENTICK_SESSION_ID}`, `${AGENTICK_SKILL_DIR}`.  |

```markdown
Run skill on issue $issueNumber.

Reference templates: ${AGENTICK_SKILL_DIR}/templates/standard.md

Arguments: $ARGUMENTS
```

### Spec fallback

When `$ARGUMENTS` (or any positional form) is **absent** from the body but args were passed, the rendered body has `ARGUMENTS: <value>` appended. So the model still sees what you sent.

## Dynamic context injection

The Claude Code spec lets skill bodies execute shell commands at activation time. The output replaces the placeholder before the body reaches the model.

### Inline form

```markdown
## Current changes

!`git diff HEAD`
```

### Block form

````markdown
## Environment

```!
node --version
git status --short
```
````

### How it runs

Both forms are executed via `session.shell()` at invocation time — the same Bash tool the agent uses. Same sandbox, same blast radius. Substitution order:

1. `$` substitutions resolve first (so `!`grep $pattern .`` gets `$pattern` substituted)
2. Shell commands execute, in document order, serially
3. Outputs are spliced into the body
4. The fully-rendered body is sent to the model

If no `<Bash>` tool is mounted, the call throws with a clear error pointing at `@agentick/sandbox`. Skills with `!` blocks need a shell to function — failing loudly is better than silently leaving the literal text.

## When to use which path

**Use the implicit `skill` tool (load-into-context) when:**

- The skill is reference content the agent should _absorb_. Style guides, conventions, multi-step procedures the agent then follows in conversation.
- You want the agent to use the skill _fluidly_ — pull it in, follow it, perhaps invoke other skills, all in one conversation.
- The skill produces free-form output (summary, plan, decision narrative).

**Use `session.skill()` (sub-execution) when:**

- You need a typed result. `result: z.object(...)` gives you a validated value.
- You want isolation. The skill's intermediate steps don't pollute the parent conversation.
- The skill is being called from non-agent code — a CRON, an HTTP handler, a workflow orchestrator.
- You want predictable structure — the same skill called twice with the same args returns the same shape.

Both work on the same skill file. Pick the path based on intent.

## Spec compliance

| Feature                                                                                  | Status                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------- | --- |
| Folder-based `<name>/SKILL.md`                                                           | ✅                                  |
| Strict name format + length, parent-dir match                                            | ✅                                  |
| Required `description` (≤1024 chars)                                                     | ✅                                  |
| `license`, `compatibility`, `metadata` (string-string)                                   | ✅                                  |
| `allowed-tools` (string or list)                                                         | ✅                                  |
| `arguments` frontmatter                                                                  | ✅                                  |
| `$ARGUMENTS` / `$N` / `$name` / `${VARS}` substitution                                   | ✅                                  |
| `` !`<cmd>` `` and ` `! ``` block injection                                              | ✅                                  |
| `app.skills` registry (register/get/list/search/loadDir/subscribe)                       | ✅                                  |
| Implicit `skill` tool with dynamic listing                                               | ✅                                  |
| `session.skill(name                                                                      | def, opts)` programmatic invocation | ✅  |
| Caller-typed `result` schema                                                             | ✅ (Agentick extension)             |
| Reserved fields (`model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell`) | ⏳ Captured, not enforced           |
| `disableSkillShellExecution` opt-out                                                     | ⏳ Future                           |

## See also

- [Agent Harness](/docs/agent-harness) — the broader programmatic surface (`shell`, `tools`, `append`, `observe`)
- [Sessions & Execution](/docs/sessions-and-execution) — session lifecycle, ticks
- [Tools](/docs/tools) — defining tools that skills can declare in `allowed-tools`
- [Sandbox](/docs/sandbox) — wiring `<Bash>` for `!` shell injection
- [agentskills.io](https://agentskills.io) — the open standard
- [Claude Code skills docs](https://code.claude.com/docs/en/skills) — the extended spec
