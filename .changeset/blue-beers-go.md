---
"@agentick/core": patch
"agentick-website": patch
---

Add the agent harness — host-facing programmatic methods on `Session` — and a
full implementation of the [Agent Skills](https://agentskills.io) open spec
plus Claude Code's substitution and shell-injection extensions.

**Agent harness:**

- `session.shell(cmd)` — sugar over `dispatch("bash", { command })`
- `session.tools.<name>(input)` — typed Proxy with dot-path namespacing
- `session.append(entry, opts?)` — primitive timeline write
- `session.observe({ type, content })` — sugar over `append` for event-role
messages
- `useOnEntry(filter, handler)` / `useOnEvent(type?, handler)` — primitive
timeline notification hooks (commit-time)

**Skills (`@agentick/core/skill`):**

- `defineSkill` / `loadSkill` / `parseSkill` — strict-spec programmatic factory
  + folder-based and flat-file loaders
- `app.skills` — `SkillRegistry` on every app: `register` / `replace` / `get` /
  `has` / `list` / `unregister` / `clear` / `search` / `subscribe` / `loadDir`
- `session.skill(name | def, { args, result?, maxTicks? })` — typed
sub-execution. Caller-provided `result` schema becomes a transient `submit`
tool the model fills with the typed answer
- Implicit `skill` tool — auto-mounted when `app.skills` is non-empty; dynamic
description lists registered skills; handler renders the body (with
substitution and shell injection) and returns it as the tool result (the spec's
  load-into-context model)
- `$ARGUMENTS` / `$N` / `$ARGUMENTS[N]` / `$name` / `${VARS}` substitution
- `` !`<command>` `` and ``` ```! ``` block shell injection — runs through
`session.shell` so injections share the agent's sandbox
- YAML frontmatter via the `yaml` package — full YAML 1.2 (block arrays,
multiline strings, nested objects)

**Spec compliance:**

- Agent Skills open spec: strict `name` regex, `description` ≤1024 chars,
`license`, `compatibility`, `metadata` (`Record<string, string>`),
`allowed-tools`, parent-directory name match for folder-loaded skills
- Claude Code extensions parsed: `when_to_use`, `argument-hint`, `arguments`,
`disable-model-invocation`, `user-invocable`
- Reserved Claude Code fields (`model`, `effort`, `context: fork`, `agent`,
`hooks`, `paths`, `shell`) documented as TODO in
`packages/core/src/skill/skill.ts` with implementation notes per phase

**Docs:** new `/docs/agent-harness` and `/docs/skills` pages;
`sessions-and-execution.md` and `packages.md` cross-updated.