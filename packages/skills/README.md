# @agentick/skills

A skill is a reusable capability document — a recipe, a playbook, a domain guide — that an agent can discover, read, and act on. This package gives a session a searchable library of them, sourced from literals, a URL, or a directory of `SKILL.md` files on disk.

Skills are **guidance, not capability**. A skill is inert content; the model is the executor. Running one is a `send` primed with its body, which is why a skill can't do anything the session couldn't already do.

## Install

```bash
npm install @agentick/skills
```

Subpaths: `/loaders` (portable sources), `/loaders/node` (filesystem), `/client` (browser-side handle), `/testing` (stub + conformance suites).

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { withSkills } from "@agentick/skills";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withSkills([
      {
        name: "weekly_status_report",
        description: "Template for the Monday morning status update.",
        content: "## Last week\n…\n## This week\n…\n## Blockers\n…",
        tags: ["reporting", "weekly"],
      },
    ]),
  ],
});
```

That's all the wiring. The model can now discover and read those skills through two tools registered for you, and adopter code reaches the same library on `session.skills`:

```ts
const skill = session.skills.get("weekly_status_report");
const matches = session.skills.search({ query: "status", tagsAny: ["reporting"] });
await session.skills.register({ name: "incident_review", description: "…", content: "…" });
```

Reads are synchronous and cheap. Mutations are async and produce audit envelopes on the session bus — every `register` / `update` / `remove` is observable.

## The `Skill` record

```ts
interface Skill {
  readonly name: string; // unique; snake_case by convention
  readonly description: string; // one line — this is what retrieval matches on
  readonly content: string; // the full body: markdown, prose, recipe
  readonly tags?: readonly string[];
  readonly allowedTools?: readonly string[]; // tool allowlist for `run`
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

Every field is plain data — no functions, no closures — so a skill round-trips through a store, a snapshot, or the wire without special handling.

## Progressive disclosure

Dumping every skill body into the prompt defeats the purpose. Instead the model gets a catalog and pulls what it needs:

| Tool         | Returns                                                       |
| ------------ | ------------------------------------------------------------- |
| `skill_list` | `{ skills: [{ name, description, tags? }] }` — no bodies      |
| `skill_read` | `{ name, description, content, tags? }` for one skill by name |

Both are registered by default; pass `registerModelTools: false` for the library without the model-facing surface. They degrade honestly rather than throwing: an unknown name comes back as `{ error: "skill_not_found", name }`, and with no library mounted `skill_list` returns an empty array.

### The second door: `skill://<name>`

Every registered skill's body is also addressable as a read-only resource at `skill://<name>` on the session's resource registry — the same registry remote MCP servers project into. MCP clients and restricted agents pull a skill like any other resource, with no bespoke wire work.

```ts
import { skillBodyUri } from "@agentick/skills";

skillBodyUri("code_review"); // "skill://code_review"
await session.resources.read(skillBodyUri("code_review"));
```

The projection is live in both directions: the resolver reads the library at read time, so an `update` shows up on the next read with no re-wiring, and a skill registered after startup projects on its next mutation while a removed one unregisters. Opt out with `exposeAsResources: false`.

Two doors, one capability. `skill_read` is the model-directed door — in-band progressive disclosure for the LLM driving the session. `skill://<name>` is the uniform-addressing door, for everyone else.

## Running a skill

`run` composes a `send` from the skill's body and hands back the ordinary execution handle. Same grammar as any other send: stream it, abort it, await it.

```ts
const handle = await session.skills.run("code_review", {
  args: { change },
  output: z.object({ approved: z.boolean(), summary: z.string() }),
});

for await (const ev of handle.events()) render(ev);

const review = await handle.result;
review.data; // typed { approved, summary }, validated
review.response; // the assistant's prose from the same turn
review.stopReason; // "output_delivered" | "end" | …
```

The mechanics, in full: resolve the skill, compose a `SendInput` — by default a system message carrying the body plus a user message carrying the serialized `args` — and send it. There is no projection layer; the handle passes through untouched. With `output` set, the send rides the structured-output path and `handle.result` resolves a validated value; without it, `data` is absent and you get prose.

**Options:** `args`, `output`, `maxTicks`, `signal`, `isolate`.

### Tool restriction

A skill carrying `allowedTools` restricts what the model can reach _for that run_: only those tools are offered to the model, the host dispatch door is unaffected, and the structured-output terminal tool is exempt. Absent means no restriction. The Node loaders populate it from Agent Skills `allowed-tools` frontmatter, so a `SKILL.md` on disk closes the loop end to end.

### Isolated runs

```ts
await session.skills.run("code_review", { args: { change }, isolate: true });
```

An isolated run executes on a fork of the current session — same image, copied state — and the child is disposed once the run settles. Nothing it does lands on the parent's timeline. An inline run is the opposite by design: its messages persist as ordinary conversation history.

> [!NOTE]
> Isolation must be bound by the composition root. A library used outside a session, or one whose host never bound an isolation runner, throws `SkillIsolationUnavailable` rather than silently degrading to an in-session run.

### Owning composition

`composeRun` is the seam. The framework ships a default; an override fully owns how a skill becomes a send — different framing, few-shot priming, its own restriction policy.

```ts
withSkills({
  composeRun: (skill, opts) => ({
    messages: [
      { role: "system", content: `# ${skill.name}\n\n${skill.content}` },
      { role: "user", content: JSON.stringify(opts.args ?? {}) },
    ],
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
  }),
});
```

> [!IMPORTANT]
> `output` is a mechanism, not a behavioral promise. The chain is: the model calls the terminal tool on its own, a forced wrap-up tick if it doesn't, then executor validation, then a typed error in the residual sliver. Whether a given model reaches for it unprompted is an eval question, never a CI assertion.

## Loading skills from disk

```ts
import { withSkills } from "@agentick/skills";
import { fromArray, fromUrl } from "@agentick/skills/loaders";
import { agentSkillsDirectory, fromDirectory, fromFile } from "@agentick/skills/loaders/node";

withSkills({
  initial: literalRecords, // registered first
  loaders: [
    fromArray(bundled),
    agentSkillsDirectory({ root: "./.agents/skills/" }),
    fromDirectory({ path: "./skills/" }),
    fromFile({ path: "./extra.md" }),
    fromUrl({ url: "https://registry.internal/skills.json" }),
  ],
});
```

| Factory                                              | Subpath         | Source                                                                                       |
| ---------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `fromArray(skills)`                                  | `/loaders`      | In-memory records                                                                            |
| `fromUrl({ url, arrayField?, … })`                   | `/loaders`      | JSON manifest — `{ "skills": [...] }` by default, or the whole body with `arrayField: null`  |
| `fromManifest(...)`                                  | `/loaders`      | Alias for `fromUrl`                                                                          |
| `fromFile({ path, parseFrontmatter? })`              | `/loaders/node` | One `.md` file with frontmatter                                                              |
| `fromDirectory({ path, match?, parseFrontmatter? })` | `/loaders/node` | Recursive walk of `.md` files; malformed records are skipped                                 |
| `agentSkillsDirectory({ root?, parseFrontmatter? })` | `/loaders/node` | [Agent Skills](https://agentskills.io/specification) layout — one skill per `<dir>/SKILL.md` |

Frontmatter parsing defaults to a minimal `key: value` reader that handles quoted strings and inline arrays. For real YAML or TOML, pass your own:

```ts
fromDirectory({ path: "./skills/", parseFrontmatter: parseYaml });
```

Nothing is added to the dependency tree at the framework level.

### The Agent Skills layout

Each immediate subdirectory of `root` (default `<cwd>/.agents/skills/`) containing a `SKILL.md` becomes one skill. A directory without one is skipped.

```
.agents/skills/
  code-review/
    SKILL.md              ← name / description / allowed-tools frontmatter + body
    references/
      checklist.md        ← skill://code-review/references/checklist.md
```

Frontmatter maps to the record: `name` defaults to the directory name when omitted; `description` is required and a directory lacking one is skipped; `allowed-tools` accepts both an inline array (`[Bash, Read]`) and a comma-separated string (`"Bash, Read"`); every other key lands on `metadata`. A missing root loads empty — a preset pointed at a default path must not explode on absence. Hidden and symlinked skill directories are rejected at load.

**Supporting files ride the resource registry.** Files under `references/` register as transient resources at `skill://<name>/references/<relpath>`, resolved lazily from disk. The model pulls them with the ordinary resource-read tool; there is no bespoke "skill file API". If no resource registry is mounted the skills still load — the references simply aren't addressable.

### Growing the library after startup

Loaders stay attached, so the library isn't frozen at boot:

```ts
const { added, updated, removed } = await session.skills.reload();

const skill = await session.skills.resolve("late_arriving"); // null if no source has it
const must = await session.skills.require("must_exist"); // throws SkillNotFound
```

`resolve` is lookup-on-miss: it walks the loaders, registers the hit, and caches it. `reload({ pruneMissing: true })` drops entries that vanished from the loader snapshot — off by default so a runtime `register` isn't clobbered by the next reload. Loaders may implement an optional `lookup(name)` for fast-path resolution without a full enumeration; every built-in factory does.

## Configuring the slot

`withSkills` takes three shapes, all collapsing to the same extension:

```ts
// An array — sugar for { initial }.
withSkills([{ name: "x", description: "x", content: "…" }]);

// An instance — one long-lived library backing every session
// (a shared on-disk DB, a remote registry, a cluster-wide replica).
withSkills(mySharedSkills);

// A config object.
withSkills({
  initial: literalRecords,
  loaders: [fromArray(bundled), fromDirectory({ path: "./skills/" })],
  store: myDurableStore,
});
withSkills({ use: mySharedSkills }); // instance, spelled out
```

**Lifecycle follows ownership.** Given `initial` / `loaders` / `store`, the extension builds one library per session and closes it at session teardown. Given an instance — bare or under `use:` — you own the lifecycle; the extension publishes it under the session's `skills` namespace and never closes it. `use` is mutually exclusive with `initial`, `loaders`, and `store`: if you bring the instance, you bring its backing too.

## Store backing

Skills are the pure floor of the definition-library shape: a serializable record keyed by name in a store, fed by loaders, with no runtime augmentation to lose in transit.

```ts
import { InMemorySkillStore } from "@agentick/skills";

withSkills({ store: new InMemorySkillStore() }); // the implicit default
```

- `register` / `update` / `remove` write through to the store.
- **Loaders feed the store; they aren't dissolved into it.** `reload()` runs each loader and puts the results; `resolve(name)` asks each loader's `lookup` and puts the hit.
- `get` / `has` / `list` / `search` stay synchronous, served from a view the library keeps in lockstep with the store — write-through on mutation, rehydrated on resume. The sync read surface and the synchronous snapshot export are both load-bearing, so the materialized view is required, not incidental.
- Snapshot export and import coexist with the store, so a session round-trips through hibernate and resume with no adopter code.

A durable adapter conforms to the same port. Certify one with `runSkillStoreConformance` from `/testing`.

## Errors

```ts
type SkillsError =
  | { _tag: "SkillNotFound"; skillName: string }
  | { _tag: "SkillAlreadyExists"; skillName: string }
  | { _tag: "SkillsBackendError"; cause: unknown }
  | { _tag: "SkillIsolationUnavailable"; skillName: string } // isolate: true, nothing bound
  | { _tag: "SkillRunnerUnbound"; skillName: string }; // run on a library with no session
```

## Over the wire

Skills project both a read lane and a write lane onto the dynamic-command wire. Every verb is individually grantable and deny-by-default — an undeclared verb is indistinguishable from an absent method.

| Method                                                | Lane  | Result                             |
| ----------------------------------------------------- | ----- | ---------------------------------- |
| `skills/list`                                         | read  | `Skill[]` — **`content` included** |
| `skills/get`                                          | read  | `Skill \| null` by name            |
| `skills/search`                                       | read  | `Skill[]`                          |
| `skills/register` · `skills/update` · `skills/remove` | write | The admin-curation lane            |

Because a `Skill` is fully serializable, the wire projection _is_ the record — the body crosses, since a client managing skills needs it. It's also unbounded, so prefer `skills/search` over `skills/list` for large libraries.

### The client handle

```ts
import "@agentick/skills/client";

const s = client.session(sessionId).skills;

s.subscribe(() => renderList(s.list())); // fires when the snapshot changes
const found = await s.search({ query: "review" }); // fresh query; snapshot untouched
await s.register({ name: "new_skill", description: "…", content: "…" }); // then re-polls
await s.refresh(); // force a re-poll
```

This handle is RPC-backed, not channel-backed — a deliberate divergence from knobs and tasks. There is no delta channel for skills, so the read side keeps a local snapshot seeded by an eager `skills/list` and re-fetches after every mutation. `list()` and `get()` read that snapshot synchronously, which is what lets the handle drop straight into `useSyncExternalStore`.

`run`, `reload`, `resolve`, and `require` are not on the client. The first needs a serializable output form that doesn't exist yet; the rest are loader and lookup concerns that don't cross the wire.

## Testing

```ts
import { stubSkillsHarness } from "@agentick/skills/testing";

const harness = await stubSkillsHarness([
  { name: "demo_skill", description: "demo", content: "body" },
]);
```

The stub brings its own in-memory substrate, so unit tests need no session machinery. `runSkillsHarnessConformance` certifies an alternate implementation against the protocol; `runSkillStoreConformance` certifies a store adapter.

## API

### `session.skills`

| Method                                           | Async | Effect                                                                |
| ------------------------------------------------ | ----- | --------------------------------------------------------------------- |
| `get(name)` / `has(name)` / `list()`             | sync  | Read by exact name, existence check, everything                       |
| `search({ query?, tagsAny?, tagsAll?, limit? })` | sync  | `query` matches name + description; `tagsAny` is OR, `tagsAll` is AND |
| `register(input)`                                | async | Create. Throws `SkillAlreadyExists` on a duplicate name               |
| `update(input)`                                  | async | Patch fields. Throws `SkillNotFound`                                  |
| `remove({ name })`                               | async | Delete. Throws `SkillNotFound`                                        |
| `subscribe(name, fn)` / `subscribeAll(fn)`       | sync  | Per-skill or any-mutation change notifications                        |
| `reload({ pruneMissing? })`                      | async | Re-run loaders; returns `{ added, updated, removed }`                 |
| `resolve(name)` / `require(name)`                | async | Lookup-on-miss; `null` vs. throw                                      |
| `run(name, opts?)`                               | async | A send primed with the skill; returns the execution handle            |

### Package exports

| Export                                     | Purpose                                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| `withSkills(slot)`                         | The session extension — array, instance, or config        |
| `SkillsHarness`                            | The implementation, for direct construction               |
| `InMemorySkillStore` / `matchesSkillQuery` | Bundled store and its search predicate                    |
| `defaultComposeRun`                        | The shipped composition, to wrap rather than replace      |
| `skillBodyUri(name)`                       | Build the `skill://<name>` resource uri                   |
| `buildSkillsTools(sessionId)`              | The `skill_list` + `skill_read` bundle, for custom wiring |
| `SKILL_LIST` / `SKILL_READ`                | Tool-name constants                                       |

`withSkills` options: `initial`, `loaders`, `store`, `composeRun`, `use`, `registerModelTools`, `exposeAsResources`.

## Patterns

**Authoring bodies as JSX.** `renderTemplate` from [@agentick/compiler-react](../compiler-react) turns a component tree into the markdown string a skill's `content` wants — useful when a body is assembled from shared fragments.

**Reaching skills from a tool handler.** The `skill_list` and `skill_read` handlers resolve the library from `ctx.skills`, the dispatch-resolved context slot this package contributes. Your own tools can do the same.

**Resources.** [@agentick/resources](../resources) owns the registry that `skill://` uris land in, and the read tool the model uses to pull them.

**Shapes.** [@agentick/spec](../spec) owns `Skill`, `SkillsRegisterInput`, the store port, and the error tags.

## Roadmap & known gaps

- **Search is substring-only** over name and description. Embedding-based retrieval isn't built; adopters needing more supply a custom implementation.
- **No durable backend ships.** SQLite (single-process durability) and a remote registry compatible with `agentskills.io` are both planned; today, bring your own store adapter.
- **`skills:run` isn't a wire command.** It needs a declarative output form that's serializable by construction.
- **Reference re-sync.** Supporting files are wired once at install. A later `reload()` or a snapshot restore doesn't re-sync them, because the lazy resolver closures don't serialize.
- **npm-packaged skills** (`fromPackage`) aren't implemented.
- **Multi-source collisions raise `SkillAlreadyExists`.** Several source directories work today, but the intended direction is layered precedence — user over project over bundled, like a settings cascade — so a local skill shadows a shipped one. That decision is coupled to the `skill://` uri shape: layering keeps it single-winner, while namespacing by source would force `skill://<source>/<name>/…`.
- **No transactions and no per-skill ACL.** Each mutation is its own operation, and all session participants share one library.

### A recorded design stance

Markdown files are the primary authoring form on purpose. Portability is the format's whole point — droppable `SKILL.md` folders, loadable from any directory at runtime, interoperable with the wider ecosystem, authored by people who don't write TypeScript. JSX authoring was considered and deferred: it's compiled app code rather than a portable artifact, so it must never become the default and fork the ecosystem. If it lands, it will be a power path into the same library, justified only by app-authored skills sharing one searchable catalog with file skills. An instruction block that re-renders but doesn't need the catalog is just a `<Section>`.

## Verified by

- `src/__tests__/harness.spec.ts` — the protocol conformance suite, sync and async surfaces, mutation envelopes on the bus, snapshot round-trip, inbox routing.
- `src/__tests__/store-backing.spec.ts` — write-through on register/update/remove, loaders feeding the store through `reload` and `resolve`, search through the sync view, snapshot-to-hydrate round-trip, plus the store conformance suite against `InMemorySkillStore`.
- `src/__tests__/run.spec.ts` — default composition, the `composeRun` override, handle pass-through with and without `output`, failures riding `handle.result`, `allowedTools` round-trip and threading, isolated runs routing through the bound runner, and the typed unbound/missing-skill errors.
- `src/__tests__/tools.spec.ts` — `skill_list` enumeration, `skill_read` content, honest degradation on an unknown name and with no library mounted, and the `registerModelTools: false` opt-out.
- `src/__tests__/projection.spec.ts` — `skill://<name>` register-then-read, live update reflection, registration after install, unregister on removal, the `exposeAsResources: false` opt-out, degradation with no resource registry, and coexistence with reference uris.
- `src/__tests__/agent-skills-directory.spec.ts` + `loaders.spec.ts` — directory discovery, the `name` default, missing-description skips, missing-root-loads-empty, symlink rejection, `allowed-tools` in both array and comma-string form, and reference files registering and reading back.
- `src/client/__tests__/skills-handle.spec.ts` + `session-skills.spec.ts` — the eager poll, each write verb followed by a re-poll, `search` leaving the snapshot alone, and the zero-argument subscribe contract.
- End-to-end coverage lives with the packages that assemble the pieces: [@agentick/app](../app) for `run` through a real session including the isolation invariant, [@agentick/session](../session) for the loop-level tool restriction, and the in-process transport suite for the `skills/list` and `skills/get` wire round-trip.
