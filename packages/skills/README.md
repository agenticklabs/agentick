# @agentick/skills

A skill is a reusable capability document — a recipe, a playbook, a domain guide — that an agent can discover, read, and act on. This package gives a session a searchable library of them, sourced from literals, a URL, or a directory of `SKILL.md` files on disk.

Skills are **guidance, not capability**. A skill is inert content; the model is the executor. Running one is a `send` primed with its body, which is why a skill can't do anything the session couldn't already do.

## Install

```bash
npm install @agentick/skills
```

Subpaths: `/hydrators` (portable sources), `/hydrators/node` (filesystem), `/client` (browser-side handle), `/testing` (stub + conformance suites).

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { hydrateFrom, withSkills } from "@agentick/skills";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withSkills({
      hydrate: hydrateFrom([
        {
          name: "weekly_status_report",
          description: "Template for the Monday morning status update.",
          content: "## Last week\n…\n## This week\n…\n## Blockers\n…",
          tags: ["reporting", "weekly"],
        },
      ]),
    }),
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
  readonly version?: string; // your revision string — see "Provenance on the timeline"
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

A skill carrying `allowedTools` restricts what the model can reach _for that run_: only those tools are offered to the model, the host dispatch door is unaffected, and the structured-output terminal tool is exempt. Absent means no restriction. The filesystem hydrators populate it from Agent Skills `allowed-tools` frontmatter, so a `SKILL.md` on disk closes the loop end to end.

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

### Provenance on the timeline

A run's messages are the skill document, not something the user typed, so every message the composition produces is stamped with where it came from — including a composition you wrote yourself:

```ts
await skills.register({
  name: "refund_flow",
  description: "…",
  content: body,
  version: "2026-01-14",
});
await session.skills.run("refund_flow", { args: { orderId: "A-1" } });

// on each message the run put on the timeline — `metadata` is an open bag, so a
// reader casts to the typed `MessageSource` seam and keys off the slot:
const source = entry.metadata?.source as MessageSource | undefined;
source?.skill; // → { name: "refund_flow", version: "2026-01-14", opId: "skills:run:01J…" }
```

`version` is yours — a semver, a deploy hash, a date, the frontmatter `version:` of the file it was hydrated from. Nothing computes it and nothing defaults it. A message your composition already stamped with its own `source` keeps it: the closer authority wins.

`opId` is the run's own operation, because `run` is a declared command: the entry navigates back to a `skills:command:run` envelope in the journal, and a guard sees the run before any content reaches the timeline.

```ts
withSkills({
  guards: {
    run: (input) =>
      input.name === "refund_flow" ? { kind: "veto", reason: "needs approval" } : undefined,
  },
});
```

A veto means nothing was composed and nothing was sent.

## Where skills come from

One option decides it: `hydrate`. A source is a function of the session's context returning the records the session opens with, and the package names the useful ones.

```ts
import { composeHydrators, hydrateFromUrl, withSkills } from "@agentick/skills";
import { hydrateFromDirectory, hydrateFromFile } from "@agentick/skills/hydrators/node";

withSkills({
  hydrate: composeHydrators(
    hydrateFromDirectory({ root: "./.agents/skills/" }),
    hydrateFromFile({ path: "./extra.md" }),
    hydrateFromUrl({ url: "https://registry.internal/skills.json" }),
  ),
});
```

| Hydrator                                             | Subpath           | Source                                                                                       |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `hydrateFrom(skills)`                                | root              | In-memory records                                                                            |
| `hydrateFromStore()`                                 | root              | The configured durable store, read in full                                                   |
| `hydrateFromUrl({ url, arrayField?, … })`            | root              | JSON manifest — `{ "skills": [...] }` by default, or the whole body with `arrayField: null`  |
| `hydrateFromManifest(...)`                           | root              | Alias for `hydrateFromUrl`                                                                   |
| `composeHydrators(...hydrators)`                     | root              | Several sources at once; on a duplicate name the LAST one wins                               |
| `hydrateFromFile({ path, parseFrontmatter? })`       | `/hydrators/node` | One `.md` file with frontmatter                                                              |
| `hydrateFromMarkdownFiles({ path, match?, … })`      | `/hydrators/node` | Recursive walk of `.md` files, one per skill; malformed records are skipped                  |
| `hydrateFromDirectory({ root?, parseFrontmatter? })` | `/hydrators/node` | [Agent Skills](https://agentskills.io/specification) layout — one skill per `<dir>/SKILL.md` |

Anything with that shape works, which is the point. A per-tenant catalog is a function reading the caller's identity:

```ts
withSkills({ hydrate: (ctx) => catalogForTier(tierOf(ctx.principal)) });
```

`composeHydrators` is an override ladder, not a merge: later sources shadow earlier ones by name, so the working tree can win over the durable catalog.

```ts
withSkills({
  store: myDurableStore,
  hydrate: composeHydrators(
    hydrateFromStore(),
    hydrateFromDirectory({ root: "./.agents/skills/" }),
  ),
});
```

> [!IMPORTANT]
> What a hydrator returns is a **seed**, not a batch of registrations. It lands in the read surface directly: no `register` operation, no store write. A hydrator reads what is already durable, or files the adopter deliberately treats as the source of truth — writing it back would duplicate the catalog on every resume. Timestamps a record carries are preserved.

A hydrator that throws fails session creation with `SkillsHydrateFailed`. That's deliberate: a session that renders against half a catalog is worse than one that doesn't start. If a degraded start is what you want, catch inside your own hydrator and return what you have.

There is no default. Configuring a `store` on its own loads nothing — which slice of a catalog a session should open with is a policy question, so ask for it (`hydrate: hydrateFromStore()`).

Frontmatter parsing defaults to a minimal `key: value` reader that handles quoted strings and inline arrays. For real YAML or TOML, pass your own:

```ts
hydrateFromDirectory({ root: "./.agents/skills/", parseFrontmatter: parseYaml });
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

Frontmatter maps to the record: `name` defaults to the directory name when omitted; `description` is required and a directory lacking one is skipped; `allowed-tools` accepts both an inline array (`[Bash, Read]`) and a comma-separated string (`"Bash, Read"`); `version` becomes the record's revision string (a number is stringified); every other key lands on `metadata`. A missing root loads empty — a source pointed at a default path must not explode on absence. Hidden and symlinked skill directories are rejected at load.

**Supporting files ride the resource registry.** Files under `references/` register as transient resources at `skill://<name>/references/<relpath>`, resolved lazily from disk. The model pulls them with the ordinary resource-read tool; there is no bespoke "skill file API". If no resource registry is mounted the skills still load — the references simply aren't addressable.

### Growing the library after startup

The source stays attached, so the library isn't frozen at boot:

```ts
const { added, updated, removed } = await session.skills.reload();

const skill = await session.skills.resolve("late_arriving"); // null if no source has it
const must = await session.skills.require("must_exist"); // throws SkillNotFound
```

Unlike the seed at session-open, a reload goes through the ordinary operations — journaled, guard-vetoable, written through to the store. `resolve` is lookup-on-miss: it re-runs the source, registers the hit, and caches it. `reload({ pruneMissing: true })` drops entries that vanished from the source — off by default so a runtime `register` isn't clobbered by the next reload.

A library with no source reloads to nothing touched, `pruneMissing` included: the absence of a source isn't a claim that the library should be empty.

A miss costs a full source read, because a source produces its whole set. For a catalog large enough to care, put it behind a `store`: the store's query is the targeted read port, and `hydrateFromStore()` opens on it.

Swap the source at runtime with `setHydrator(hydrate)`, or pass `undefined` to detach it. Detaching doesn't un-register what the source already produced.

## Configuring the slot

`withSkills` takes a plan or a live library — two shapes, one type:

```ts
// A plan. Constructed per session, closed at session teardown.
withSkills({
  store: myDurableStore,
  hydrate: hydrateFromDirectory({ root: "./.agents/skills/" }),
});

// A live library — one long-lived instance backing every session
// (a shared on-disk DB, a remote registry, a cluster-wide replica).
withSkills(mySharedSkills);
```

Name the plan with `defineSkills` when you want to hand it around — a config module exports one, a test imports it and overrides a single slot:

```ts
import { defineSkills, hydrateFrom, hydrateFromDirectory } from "@agentick/skills";

// skills.ts
export default defineSkills({
  store: myDurableStore,
  hydrate: hydrateFromDirectory({ root: "./.agents/skills/" }),
  guards: { register: (input) => (input.name.startsWith("_") ? { kind: "veto" } : undefined) },
});

// skills.test.ts — same policy, a fixture source
import production from "./skills.js";
const underTest = defineSkills({ ...production, hydrate: hydrateFrom(fixtures) });
```

`defineSkills` is identity plus a brand: it returns what you gave it. Nothing is constructed, no store is opened, and no hydrator runs until a session installs it.

**Lifecycle follows ownership.** Given a plan, the extension builds one library per session, runs genesis, and closes it at session teardown. Given a live instance, you own the lifecycle: the extension publishes it under the session's `skills` namespace, never runs genesis on it, and never closes it.

### Policy on the plan

`hooks:` observes and transforms; `guards:` decides. Both name this library's own verbs, with the layer prefix dropped:

```ts
defineSkills({
  hooks: { onBeforeRegister: (input) => ({ ...input, name: input.name.toLowerCase() }) },
  guards: {
    register: (input) =>
      isReserved(input.name) ? { kind: "veto", reason: "reserved" } : undefined,
  },
});
```

App-level policy wraps these: an app guard decides before a plan-level guard is consulted, and an app before-hook runs before a plan-level one. Governance outranks local policy. Guards never gate the genesis seed — the seed isn't a `register`, so admission policy over the _source_ belongs in the hydrator.

## Store backing

Skills are the pure floor of the definition-library shape: a serializable record keyed by name in a store, fed by a hydrator, with no runtime augmentation to lose in transit.

```ts
import { InMemorySkillStore } from "@agentick/skills";

withSkills({ store: new InMemorySkillStore() }); // the implicit default
```

- `register` / `update` / `remove` write through to the store.
- **The source feeds the store; it isn't dissolved into it.** `reload()` re-runs the hydrator and puts the results; `resolve(name)` does the same for one name. The session-open seed is the exception — it reads, it never writes.
- `get` / `has` / `list` / `search` stay synchronous, served from a view the library keeps in lockstep with the store — write-through on mutation, rehydrated on resume. The render pass reads it synchronously, so the materialized view is required, not incidental.
- **A store alone does not resume you.** The library names no default hydrator, so an imperative `register()` survives an evict / restart only when the definition also configures one (`hydrate: hydrateFromStore()`). Skills a tree re-declares on mount need neither.

A durable adapter conforms to the same port. Certify one with `runSkillStoreConformance` from `/testing`.

## Errors

```ts
type SkillsError =
  | { _tag: "SkillNotFound"; skillName: string }
  | { _tag: "SkillAlreadyExists"; skillName: string }
  | { _tag: "SkillsBackendError"; cause: unknown }
  | { _tag: "SkillsHydrateFailed"; cause: unknown } // genesis threw; session creation fails
  | { _tag: "SkillIsolationUnavailable"; skillName: string } // isolate: true, nothing bound
  | { _tag: "SkillRunnerUnbound"; skillName: string }; // run on a library with no session
```

## Over the wire

Skills project both a read lane and a write lane onto the dynamic-command wire. Every verb is individually grantable and deny-by-default — an undeclared verb is indistinguishable from an absent method.

| Method                                                | Lane  | Result                                                       |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------ |
| `skills/list`                                         | read  | `{ skills, nextCursor? }` — one page; **`content` included** |
| `skills/get`                                          | read  | `Skill \| null` by name                                      |
| `skills/search`                                       | read  | `Skill[]`                                                    |
| `skills/register` · `skills/update` · `skills/remove` | write | The admin-curation lane                                      |
| `skills/commands`                                     | read  | The declared verbs with their exposure — the discovery door  |

`skills/commands` is served by the base rather than declared here, and it answers what this session's skill surface can do — including which verbs are wire-exposed at all, so a client learns that `skills:run` is in-process only instead of discovering it as a `MethodNotFound`. See [@agentick/gateway](../gateway#discovery--two-doors).

Because a `Skill` is fully serializable, the wire projection _is_ the record — the body crosses, since a client managing skills needs it. It's also unbounded, so prefer `skills/search` over `skills/list` for large libraries.

`skills/list` is paged, MCP-shaped: pass the previous reply's `nextCursor` to continue, and its absence means you have the last page. The in-process `list()` is unchanged — a bounded snapshot, no cursor. That split is the rule across the framework: iterating a collection in-process is bounded by construction, while a wire read has to bound itself, so pagination lives at the wire and at projections, never on the harness's own sync read.

### The client handle

```ts
import "@agentick/skills/client";

const s = client.session(sessionId).skills;

s.subscribe(() => renderList(s.list())); // fires when the snapshot changes
const found = await s.search({ query: "review" }); // fresh query; snapshot untouched
await s.register({ name: "new_skill", description: "…", content: "…" }); // then re-polls
await s.refresh(); // force a re-poll
```

This handle is RPC-backed, not channel-backed — a deliberate divergence from knobs and tasks. There is no delta channel for skills, so the read side keeps a local snapshot seeded by an eager `skills/list` and re-fetches after every mutation. `list()` and `get()` read that snapshot synchronously, which is what lets the handle drop straight into `useSyncExternalStore`. Only the FIRST page seeds the snapshot; walking cursors is the power-user path, issued against `skills/list` directly.

The snapshot fills itself: the handle polls once on construction and fires `subscribe` when the answer lands, so the right shape is to bind both — render what `list()` has, re-render on change — and there is nothing to await and no boot-time `refresh()` to issue. `refresh()` is for invalidating a snapshot you already have. A first poll that fails leaves the snapshot empty rather than half-filled; the next mutation's re-fetch or an explicit `refresh()` recovers it.

`run`, `reload`, `resolve`, and `require` are not on the client. The first needs a serializable output form that doesn't exist yet; the rest are source and lookup concerns that don't cross the wire.

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
| `reload({ pruneMissing? })`                      | async | Re-run the source; returns `{ added, updated, removed }`              |
| `resolve(name)` / `require(name)`                | async | Lookup-on-miss; `null` vs. throw                                      |
| `run(name, opts?)`                               | async | A send primed with the skill; returns the execution handle            |

### Package exports

| Export                                                                     | Purpose                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `withSkills(config)`                                                       | The session extension — a plan or a live library          |
| `defineSkills(options)`                                                    | Name a plan: identity + brand, inert until install        |
| `hydrateFrom` / `hydrateFromStore` / `hydrateFromUrl` / `composeHydrators` | The portable sources                                      |
| `SkillsHarness`                                                            | The implementation, for direct construction               |
| `InMemorySkillStore` / `matchesSkillQuery`                                 | Bundled store and its search predicate                    |
| `defaultComposeRun`                                                        | The shipped composition, to wrap rather than replace      |
| `skillBodyUri(name)`                                                       | Build the `skill://<name>` resource uri                   |
| `buildSkillsTools(sessionId)`                                              | The `skill_list` + `skill_read` bundle, for custom wiring |
| `SKILL_LIST` / `SKILL_READ`                                                | Tool-name constants                                       |

`withSkills` / `defineSkills` options: `store`, `hydrate`, `composeRun`, `registerModelTools`, `exposeAsResources`, `hooks`, `guards`.

## Patterns

**Authoring bodies as JSX.** `renderTemplate` from [@agentick/compiler-react](../compiler-react) turns a component tree into the markdown string a skill's `content` wants — useful when a body is assembled from shared fragments.

**Reaching skills from a tool handler.** The `skill_list` and `skill_read` handlers resolve the library from `ctx.skills`, the dispatch-resolved context slot this package contributes. Your own tools can do the same.

**Resources.** [@agentick/resources](../resources) owns the registry that `skill://` uris land in, and the read tool the model uses to pull them.

**Shapes.** [@agentick/spec](../spec) owns `Skill`, `SkillsRegisterInput`, the store port, and the error tags.

## Roadmap & known gaps

- **Search is substring-only** over name and description. Embedding-based retrieval isn't built; adopters needing more supply a custom implementation.
- **No durable backend ships.** SQLite (single-process durability) and a remote registry compatible with `agentskills.io` are both planned; today, bring your own store adapter.
- **`skills:run` is in-process only.** It's a declared command — journaled, guard-vetoable, carrying an opId — but `exposure: "internal"`, because a run returns a live execution handle (an event stream and an `abort()`), which is not data and cannot cross the inbox or the wire. It widens when `session:send` gets the serializable output form it's parked on.
- **Reference re-sync.** Supporting files are wired once at install. A later `reload()` or a resume off the store doesn't re-sync them, because the lazy resolver closures don't serialize.
- **npm-packaged skills** (`fromPackage`) aren't implemented.
- **Layered precedence across sources is manual.** `composeHydrators` resolves a duplicate name last-wins, which gives you a cascade if you order the sources yourself. A first-class user-over-project-over-bundled ladder isn't built; it's coupled to the `skill://` uri shape, since layering keeps it single-winner while namespacing by source would force `skill://<source>/<name>/…`.
- **No transactions and no per-skill ACL.** Each mutation is its own operation, and all session participants share one library.

### A recorded design stance

Markdown files are the primary authoring form on purpose. Portability is the format's whole point — droppable `SKILL.md` folders, loadable from any directory at runtime, interoperable with the wider ecosystem, authored by people who don't write TypeScript. JSX authoring was considered and deferred: it's compiled app code rather than a portable artifact, so it must never become the default and fork the ecosystem. If it lands, it will be a power path into the same library, justified only by app-authored skills sharing one searchable catalog with file skills. An instruction block that re-renders but doesn't need the catalog is just a `<Section>`.

## Verified by

- `src/__tests__/harness.spec.ts` — the protocol conformance suite, sync and async surfaces, mutation envelopes on the bus, the construction seed, inbox routing.
- `src/__tests__/store-backing.spec.ts` — write-through on register/update/remove, the source feeding the store through `reload` and `resolve`, search through the sync view, store-to-seed round-trip, plus the store conformance suite against `InMemorySkillStore`.
- `src/__tests__/definition.spec.ts` — `defineSkills` identity, the non-enumerable brand, inertness (no store touch, no hydrator run), the plan-or-instance shapes, and plan portability.
- `src/__tests__/genesis.spec.ts` — the seed law (no store write, no `register` operation), timestamp preservation, typed `SkillsHydrateFailed` including through the extension install, the `ctx.store` / `ctx.principal` / journal-reader facets, a re-run restamping rather than duplicating, and the app-wraps-plan ordering for hooks and guards.
- `src/__tests__/hydrators.spec.ts` + `hydrators-node.spec.ts` — each named source, `composeHydrators` ordering and last-wins, directory discovery, the `name` default, missing-description skips, missing-root-loads-empty, symlink rejection, `allowed-tools` in both array and comma-string form, and reference files registering and reading back.
- `src/__tests__/source-surface.spec.ts` — `reload` adds/updates/prunes, `resolve` and `require` on hit and miss, a source-less harness touching nothing, and reload-writes-while-genesis-does-not.
- `src/__tests__/run.spec.ts` — default composition, the `composeRun` override, handle pass-through with and without `output`, failures riding `handle.result`, `allowedTools` round-trip and threading, isolated runs routing through the bound runner, the typed unbound/missing-skill errors, the provenance stamp on every composed message (name, declared version, and the run's opId — present on an override's messages too, merged into their metadata, and never overwriting a source the composition set itself), and `skills:run` as an operation: requested and terminal envelopes on a success, a terminal `failed` on a missing skill, a guard veto composing no send at all, and the stamped opId matching the envelope's.
- `src/conformance.ts` §declared version is a contract + `src/store-conformance.ts` — `version` is a contract every implementation and every store adapter must satisfy, not a field that happens to survive: verbatim through register / get / list / search and through the store's single-read and enumerate lanes, patchable by `update`, left alone by a patch that omits it, and staying absent when undeclared (nothing defaults it). `hydrators-node.spec.ts` §version mapping pins the frontmatter `version:` landing on the field rather than the metadata bag.
- `src/__tests__/tools.spec.ts` — `skill_list` enumeration, `skill_read` content, honest degradation on an unknown name and with no library mounted, and the `registerModelTools: false` opt-out.
- `src/__tests__/projection.spec.ts` — `skill://<name>` register-then-read, live update reflection, registration after install, unregister on removal, the `exposeAsResources: false` opt-out, degradation with no resource registry, and coexistence with reference uris.
- `src/client/__tests__/skills-handle.spec.ts` + `session-skills.spec.ts` — the eager poll notifying subscribers when it lands (so no boot-time `refresh()` is needed) and settling empty on a failed poll that `refresh()` then recovers, each write verb followed by a re-poll, `search` leaving the snapshot alone, and the zero-argument subscribe contract.
- End-to-end coverage lives with the packages that assemble the pieces: [@agentick/app](../app) for `run` through a real session including the isolation invariant, [@agentick/session](../session) for the loop-level tool restriction, and the in-process transport suite for the `skills/list` and `skills/get` wire round-trip.
