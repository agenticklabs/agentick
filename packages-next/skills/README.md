# @agentick/skills-next

`SkillsHarness` — durable, searchable agent skill libraries. OpenClaw / Hermes style: reusable recipes that persist across sessions, surface via the same audit + envelope discipline as the other v2 harnesses.

A **skill** is opaque content (markdown / prose / structured recipe) that an agent can register, search, and reference. The harness owns storage + lookup; the agent's prompt design decides what to do with retrieved skills.

> Pre-1.0. Shape 1 harness per [ADR 32](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md): substrate participation, audit envelopes, swappable backend, snapshot/restore.

## Quick start

```ts
import { createApp } from "@agentick/app-next";
import { withSkills } from "@agentick/skills-next";

const app = createApp(<Agent />, {
  model: openai("gpt-5"),
  extensions: [
    withSkills({
      initial: [
        {
          name: "weekly_status_report",
          description: "Template for the Monday morning status update.",
          content: "## Last week\n...\n## This week\n...\n## Blockers\n...",
          tags: ["reporting", "weekly"],
        },
      ],
    }),
  ],
});

// Inside a session — agent or adopter code accesses session.skills:
const skill = session.skills.get("weekly_status_report");
const matches = session.skills.search({ query: "status", tagsAny: ["reporting"] });
await session.skills.register({ name: "..", description: "..", content: ".." });
```

## `Skill` shape

```ts
interface Skill {
  readonly name: string; // unique within the harness; snake_case convention
  readonly description: string; // one-line summary for retrieval / listing
  readonly content: string; // full body — markdown / prose / recipe
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>; // adopter-defined
  readonly updatedAt: number; // wall-clock ms
  readonly createdAt: number;
}
```

Skills are first-class data. The harness treats them as opaque content; the agent's prompt design decides what to do with them. Authoring `content` via `renderTemplate` from `@agentick/compiler-react-next` (JSX → markdown string) is the recommended pattern for richer skill bodies.

## API — `SkillsHandle` on `session.skills`

| Method                                                       | Async? | Effect                                                                                                                                    |
| ------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `get(name)`                                                  | sync   | Read by exact name; `undefined` if missing                                                                                                |
| `has(name)`                                                  | sync   | Existence check                                                                                                                           |
| `list()`                                                     | sync   | All skills (no filter)                                                                                                                    |
| `search({ query?, tagsAny?, tagsAll?, limit? })`             | sync   | Filtered subset. `query` matches `name` + `description` (case-insensitive substring in reference impl); `tagsAny` is OR, `tagsAll` is AND |
| `register({ name, description, content, tags?, metadata? })` | async  | Create. Throws `{_tag: "SkillAlreadyExists"}` on duplicate name                                                                           |
| `update({ name, description?, content?, tags?, metadata? })` | async  | Patch fields. Throws `{_tag: "SkillNotFound"}` if missing                                                                                 |
| `remove({ name })`                                           | async  | Delete. Throws `{_tag: "SkillNotFound"}` if missing                                                                                       |
| `subscribe(name, listener)`                                  | sync   | Listen for a specific skill's mutations                                                                                                   |
| `subscribeAll(listener)`                                     | sync   | Listen for any mutation                                                                                                                   |
| `run(name, opts?)`                                           | async  | Run the skill — a `session.send` primed with the skill (see below)                                                                        |

Reads are cheap and synchronous (no envelopes). Mutations go through `runOperation` — every `register` / `update` / `remove` produces `requested → terminal` envelopes on the session's bus that the model, admins, or audit tooling can observe.

### Wire surface (`exposure: "wire"`, deny-by-default)

Skills projects both a MUTATION lane and a READ lane onto the dynamic-command wire (three-audiences-plan G-prep — the read lane was added so a client skills handle can enumerate; skills previously had register/update/remove only):

| Wire method                                           | Reads / writes | Result                                                |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------- |
| `skills/list`                                         | read           | `Skill[]` — wire-safe records, **`content` included** |
| `skills/get`                                          | read           | `Skill \| null` (by `name`)                           |
| `skills/search`                                       | read           | `Skill[]` (mirrors `SkillsSearchInput`)               |
| `skills/register` · `skills/update` · `skills/remove` | write          | admin-curation lane (#141)                            |

A `Skill` is fully serializable, so the wire projection **is** the record — `content` (the skill body) crosses because a client managing skills needs it; note it is unbounded, so prefer `skills/search` over `skills/list` for large libraries. Every verb is grantable and deny-by-default (an undeclared verb is indistinguishable from an absent method).

Failures are typed:

```ts
type SkillsError =
  | { _tag: "SkillNotFound"; name: string }
  | { _tag: "SkillAlreadyExists"; name: string }
  | { _tag: "SkillsBackendError"; cause: unknown }
  | { _tag: "SkillIsolationUnavailable"; name: string } // isolate: true, no isolation runner bound
  | { _tag: "SkillRunnerUnbound"; name: string }; // run on a harness with no session
```

## `skills.run` — the model executes, the skill guides

`run` is the flagship consumer of the structured-output path (three-audiences-plan §C, riding §B2). Flue's line holds: **skills guide agent work; they do not add executable capabilities.** A skill run is nothing more than a `session.send` primed with the skill's content — the skill stays inert data, the **model** is the executor.

```ts
const handle = await session.skills.run("review", {
  args: { change },
  output: z.object({ approved: z.boolean(), summary: z.string() }),
});

// The send grammar, verbatim — stream the run live, abort it, or await it:
for await (const ev of handle.events()) render(ev);

const review = await handle.result;
review.data; // typed { approved, summary }, validated
review.response; // the assistant's prose (same turn as the data)
review.stopReason; // "output_delivered" (terminal-tool path) | "end" | …
```

**Mechanics.** `require(name)` → compose a `SendInput` (default: a `system`-role message carrying the skill body + framing, then a `user`-role message carrying the serialized `args`) → `session.send` → **the execution handle passes through untouched** (`SessionExecutionHandle<T>` — one grammar with `send`; no projection layer). With `opts.output`, the send rides the terminal-tool strategy (§B2); `handle.result` resolves a `SendResult<T>` whose `data` is the validated value. No `output` → `data` is absent, `response` still returned.

**`opts`:** `{ args?, output?, maxTicks?, signal?, isolate? }`. `args` serialize into the run's user message; `output` (a `StandardSchemaV1`) drives structured extraction; `maxTicks` / `signal` pass straight to the send; `isolate: true` routes through `session.fork()` (see below).

**Tool restriction (`Skill.allowedTools`).** A skill record may carry an `allowedTools?: readonly string[]` allowlist (canonical tool names). When present, `defaultComposeRun` threads it into the run's `SendInput.allowedTools` — the per-execution tool-**restriction** seam (C2): only those tools reach the **model** for this run; the dispatch door is unaffected, and the structured-output terminal tool is exempt (loop-injected after restriction). Absent = no restriction. The skill record is the only source in C2 (no `opts`-level override); the Agent Skills frontmatter `allowed-tools` loader that populates it is E-loader work (`TODO(E1)`).

**Composition seam (seam over setting).** `withSkills({ composeRun })` — a `(skill, opts) => SendInput` callback. The framework ships the default; the seam is the truth. An override fully owns composition (different framing, few-shot priming, or overriding the `allowedTools` restriction).

**Honest guarantees (do not read this as a general structured-output promise).** When `output` is set the chain is: description-driven natural path (the model calls the terminal tool) → forced wrap-up tick (`toolChoice` forcing — a hard provider guarantee) → executor validation → typed error in the residual sliver (`StructuredOutputIncomplete` / `ResponseValidationError`). Behavioral compliance ("does the model call it unforced") is the eval tier, never asserted in CI. See three-audiences-plan §B2's guarantees section.

**Reentrancy.** A `run` carrying `output` that **races an in-flight execution** QUEUES — the run leaves `onBusy` unset, and the send's smart default resolves a structured send to `"queue"` (a steer has no final turn of its own to shape). The run waits for the session to quiesce, then executes fresh and delivers its structured result. No error, no manual quiescing needed.

**Timeline.** An inline run's messages persist as ordinary history (the skill's system message, the args, the assistant turn, any tool calls). Inline runs are conversation work by design. An **isolated** run (`isolate: true`) is the opposite: it executes on a disposable fork, so none of its messages land on the calling session's timeline.

**Injection (how `run` reaches `session.send`).** The skills harness is constructed from substrate alone — it has **no** session access. The send capability is late-bound at session install via `bindRunner(send)` (the `adoptTelemetry` precedent; the App's session-construction fold feature-detects the `RunnerBindable` contract and injects **only** the send capability, never the session). A harness constructed outside a session throws `SkillRunnerUnbound` on `run`. This keeps `@agentick/skills-next` free of any `session-next` edge.

**`isolate: true` — isolated fork execution (C2).** An isolated run executes on a fresh `session.fork()` (a same-image, copied-state child) instead of the current session, and the child is disposed after the run settles. Nothing from the isolated run touches the parent's timeline/state — the isolation invariant. The runner is late-bound at session install via `bindIsolationRunner` (the optional sibling to `bindRunner`; the App's fold binds a `fork → send → dispose-after-settle` closure). A harness with **no** isolation runner bound (a harness outside a session, or a composition root that never bound it) still throws `SkillIsolationUnavailable` on `isolate: true` — never a silent degrade to a same-session run.

## Inbox addressing

The harness is inbox-addressable at `skills:{scopeId}`. Adopters needing cross-harness coordination can route messages via the inbox:

```ts
await inbox.send({ addressedTo: "skills:s_42", type: "skills:register", payload: { ... } });
```

## The `withSkills` slot — three accepted shapes

Per [ADR 42](../../docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md) `withSkills` accepts a trichotomic slot — array, instance, or config object. All three collapse to the same internal `WithSkillsOptions` shape and produce a `SessionExtension`.

```ts
import { withSkills } from "@agentick/skills-next";

// Form A — array shorthand (sugar for { initial })
withSkills([{ name: "x", description: "x", content: "..." }]);

// Form B — instance shorthand. Adopter brings a long-lived
// `Skills` source that backs EVERY session (shared on-disk DB,
// remote registry, cluster-wide replica). The extension does NOT
// construct or close it — adopter owns the full lifecycle.
withSkills(mySharedSkillsHarness);

// Form C — config object
withSkills({
  initial: [/* SkillsRegisterInput[] */],
  loaders: [fromArray([...]), fromDirectory("./skills")],
  store: myDurableSkillStore, // optional — durable backing (see below)

  // OR — adopter-supplied instance (mutually exclusive with initial / loaders / store)
  use: mySharedSkillsHarness,
});
```

**Lifecycle ownership.** Forms A / C-with-`initial`/`loaders`/`store` → extension constructs a per-session harness and closes it on session teardown. Forms B / C-with-`use:` → adopter owns the source's lifecycle; the extension publishes the same instance under the session's `skills` namespace but never closes it.

## Store backing — the definition-library archetype

The harness is **store-derived and store-persisted** ([data-layer plan §6-C](../../docs/proposals/v2/data-layer-plan.md)). Skills are the archetype's **pure floor**: a serializable `Skill` record keyed by `name` in a `SkillStore` (= `CollectionStore<Skill, SkillStoreQuery>`), fed by pluggable `Loader` sources, with **no runtime augmentation** (unlike prompts' `render`/`template` fn, or resources' `resolver`). Every field of a `Skill` is plain data, so the store round-trips it whole.

```ts
import { InMemorySkillStore } from "@agentick/skills-next";
// The SkillStore / SkillStoreQuery ports live in @agentick/spec-next.

withSkills({ store: new InMemorySkillStore() }); // the bundled default (implicit)
```

- **`register` / `update` / `remove`** write through to `store.put` / `store.delete`.
- **Loaders stay _sources_ that FEED the store** — they are not dissolved into it. `reload()` runs each loader's `load()` and puts the results; `resolve(name)` (lookup-on-miss) asks each loader's `lookup()` then puts the hit.
- **`get` / `has` / `list` / `search` are synchronous**, served from an eager `View` (a sync read cache the harness keeps in lockstep with the store: write-through on mutation, `hydrate()` on resume). This mirrors the `KnobsHarness`. The view is required, not incidental — the sync `exportSnapshot()` (`SnapshotCapable`, captured synchronously by the compiler) and the sync read surface are both load-bearing sync callers, so a synchronous materialized view is mandatory. (Credentials, the async counter-example, has _no_ snapshot surface, which is why it needs no view.)
- **`exportSnapshot` / `importSnapshot` coexist** with the store today (a Phase-4 manifest sweep makes the store the sole snapshot authority later). A durable adapter (Postgres, a filesystem source) conforms to the same `SkillStore` port.

## Backend swap

The reference `SkillsHarness` keeps skills in memory (with snapshot/restore). The protocol is backend-agnostic — `SkillsHarnessProtocol` in `@agentick/spec-next` defines the shape; alternative implementations slot in:

- **`SqliteSkillsHarness`** (planned) — durable single-process backend; survives process restart without snapshot/restore plumbing.
- **`RemoteSkillsHarness`** (planned) — `agentskills.io`-compatible remote registry; cross-session, cross-process library.

To plug a custom backend in today, construct your impl once + pass it via the `use:` escape hatch (or top-level instance shorthand). Form B is exactly this hand-off.

## Snapshot / restore

`SkillsHarness extends BaseHarness` and implements `SnapshotCapable`: `exportSnapshot()` returns the full skill set; `importSnapshot(snapshot)` replaces it. Round-trips through the session's hibernation/resume machinery automatically — adopters get persistence across session lifecycle without writing code.

## Testing

```ts
import { stubSkillsHarness } from "@agentick/skills-next/testing";

const harness = await stubSkillsHarness([
  { name: "demo_skill", description: "demo", content: "body" },
]);
// harness has its own in-memory substrate (journal/bus/inbox).
// Use directly in tests; no full session machinery needed.
```

Cross-harness integration testing — when verifying that skills interact correctly with the compiler, session, or other harnesses — uses `runSkillsHarnessConformance` against the real protocol surface.

## Loaders

`withSkills({ loaders })` accepts a `SkillLoader[]` for sourcing the initial library from disk, URLs, or in-memory arrays. All sources are sound for skills because `Skill.content` is always a `string` (no functions to serialize).

```ts
import { withSkills } from "@agentick/skills-next";
import { fromArray, fromUrl } from "@agentick/skills-next/loaders";
import { fromDirectory, fromFile } from "@agentick/skills-next/loaders/node";

withSkills({
  initial: [/* literal records, registered first */],
  loaders: [
    fromArray(bundled),
    fromDirectory({ path: "./skills/" }),    // walks .md files w/ frontmatter
    fromFile({ path: "./extra.md" }),
    fromUrl({ url: "https://registry.internal/skills.json" }),
  ],
}),
```

| Factory                                                   | Subpath         | Source                                                                 |
| --------------------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `fromArray(skills)`                                       | `/loaders`      | in-memory                                                              |
| `fromUrl({ url, ... })`                                   | `/loaders`      | JSON manifest at `{ "skills": [...] }` (configurable via `arrayField`) |
| `fromManifest(...)`                                       | `/loaders`      | alias for `fromUrl`                                                    |
| `fromFile({ path, parseFrontmatter? })`                   | `/loaders/node` | one `.md` file with frontmatter                                        |
| `fromDirectory({ path, match?, parseFrontmatter?, ... })` | `/loaders/node` | recursive walk of `.md` files; bad records skipped silently            |

Frontmatter parsing defaults to a minimal `key: value` parser (`parseSimpleFrontmatter` — supports quoted strings + inline arrays like `[a, b, c]`). For full YAML / TOML, pass a custom `parseFrontmatter: (text) => Record<string, unknown>` callback — wire `yaml` / `@iarna/toml` / your parser of choice without adding a dep at the framework level.

### Dynamic — post-startup `reload()` + `resolve(name)`

Loaders are retained on the harness, so the library can grow after session boot:

```ts
// Adopter drops a new file into ./skills/, then:
const { added, updated, removed } = await session.skills.reload();
// → { added: ["new_skill"], updated: [], removed: [] }

// Or pull a single skill lazily (lookup-on-miss):
const skill = await session.skills.resolve("late_arriving");
// First call walks loaders, registers + returns. Subsequent calls
// hit cache. Returns null when no loader has the name.

// Throw-on-miss variant for must-exist contracts:
const skill = await session.skills.require("must_exist");
// → throws { _tag: "SkillNotFound", name: "must_exist" } if no source has it.
```

`reload({ pruneMissing: true })` removes entries that have disappeared from the loader snapshot — off by default so a runtime `harness.register(...)` isn't clobbered by the next reload. Loaders may implement an optional `lookup(name)` for fast-path resolution (no full enumeration); the built-in `fromX` factories do.

## Status & roadmap

**Shipped:**

- `SkillsHarness` reference impl (in-memory, journal-backed)
- `withSkills` session-extension factory (accepts `loaders`)
- `SkillLoader[]` — `fromArray` / `fromUrl` / `fromManifest` (`/loaders`) and `fromFile` / `fromDirectory` (`/loaders/node`)
- Store backing — `SkillStore` port (spec-next), bundled `InMemorySkillStore`, `store` slot on `withSkills`
- Conformance suites — `runSkillsHarnessConformance` (harness) + `runSkillStoreConformance` (store)
- `/testing` subpath with `stubSkillsHarness`
- Module augmentation: `session.skills` typed via `SkillsHandle` (optional slot — uniform with `live` / `prompts`)
- `skills.run(name, opts)` — inline skill execution on the structured-output path (C-core); `composeRun` seam; late-bound `bindRunner` injection
- **`skills.run(name, { isolate: true })` (C2)** — routes through `session.fork()` (same-image, copied-state child disposed after the run) via the late-bound `bindIsolationRunner`; unbound ⇒ `SkillIsolationUnavailable`. Verified by `src/__tests__/run.spec.ts` (routing) + `@agentick/app-next` `src/__tests__/skills-run-e2e.spec.tsx` (isolation invariant + dispose).
- **`Skill.allowedTools` (C2)** — per-execution tool-**restriction** allowlist threaded into `SendInput.allowedTools` by `defaultComposeRun`; applied in the loop on the merged model-visible list. Verified by `src/__tests__/run.spec.ts` (round-trip + threading) + `@agentick/session-next` `src/__tests__/tool-restriction.spec.ts` (loop filter).

**Planned:**

- **`skills.run` C2 follow-up (remaining).** A `skills:run` `exposure: "wire"` command (needs the declarative `responseFormat` output form — serializable by construction). The `Skill.allowedTools` field is populated from Agent Skills frontmatter `allowed-tools` by the E-loader (`TODO(E1)`).

- SQLite backend for single-process durability
- Remote-registry backend (`agentskills.io` compatibility)
- Embedding-based search (currently substring-only)
- Skill versioning / history
- **Bundled skill assets via a `skill://` resource namespace.** A skill is
  currently `{ name, description, content }` — instructions only. Folder-shaped
  skills (a `SKILL.md` plus reference files, examples, data) want _progressive
  disclosure_: the instructions surface on activation, and the supporting files
  are pulled on demand. Those files are **resources**, not a new subsystem —
  register them into the session `ResourcesHarness` under a
  `skill://<name>/<path>` namespace with a directory-backed resolver, exactly
  the aliased-resolver pattern already shipped for the sandbox (`file://`) and
  remote MCP servers (`mcp://<alias>/`). Progressive disclosure then _is_ lazy
  resource reads (register lazy resolvers, don't eagerly read the bytes), and
  skill assets get catalog surfacing + MCP projection for free. The skill's
  **instructions stay push** (conditionally-activated context, not a pull) —
  only the asset layer is resources. See ADR 62 (resources seam) and ADR 65
  (compose onto the existing seam, don't add a subsystem).
- **Multi-source precedence.** Multiple source folders already work today (pass
  several `fromDirectory` loaders). What's undecided is the collision policy when
  two sources define the same skill name — today the harness raises
  `SkillAlreadyExists`. Intended direction: **layered precedence** (user >
  project > bundled, like a settings cascade) so a local skill shadows a shipped
  one. This decision and the `skill://` asset-URI shape are coupled: layering
  keeps `skill://<name>/…` single-winner; source-namespacing would force
  `skill://<source>/<name>/…`.

**Design stance (recorded from review):**

- **Markdown/file is the primary authoring form, deliberately.** Portability is
  the skill format's whole point (droppable `SKILL.md` folders, runtime-loadable
  from any directory, `agentskills.io` interop, non-engineer authored). JSX/TSX
  `<Skill>` authoring (reactive, compiled, in-tree — the read-side analogue of
  `<Resource>`) was considered and **deferred**: it is compiled app code, not a
  portable artifact, so it must never become the default and fork the ecosystem.
  If added later it is a power-path front-end into the SAME `SkillsHarness`
  registry, justified ONLY by "app-authored skills share one searchable catalog +
  activation model with file-skills" — a reactive instruction block that doesn't
  need the catalog is just a `<Section>`.

**Known gaps:**

- Search is substring-only on `name` + `description`. Adopters who need richer retrieval supply a custom harness backend.
- No transaction support across multiple mutations — each `register`/`update`/`remove` is its own Operation.
- No per-skill ACL — all session participants share one library.

## Verified by

- `src/__tests__/harness.spec.ts` — full conformance suite + sync/async surface + envelope flow + snapshot round-trip + inbox routing
- `src/__tests__/store-backing.spec.ts` — write-through to the injected store, loaders (`reload` / `resolve`) feed the store, `search` through the projection, `exportSnapshot`↔`hydrate()` round-trip, plus `runSkillStoreConformance` against `InMemorySkillStore`
- `src/__tests__/run.spec.ts` — `skills.run` harness mechanics (dependency-free, stub runner): default composition (system skill body + serialized args), `composeRun` seam override, handle pass-through (with / without `output`; failures ride `handle.result`), `isolate: true` with no isolation runner→`SkillIsolationUnavailable` / with one bound→routes through it (not the plain runner), `Skill.allowedTools` round-trip + threading into `SendInput.allowedTools`, unbound runner→`SkillRunnerUnbound`, missing skill→`SkillNotFound`
- `@agentick/app-next` `src/__tests__/skills-run-e2e.spec.tsx` — `session.skills.run` end-to-end through `createApp` (proves the C-core `bindRunner` injection site): `output`→validated `data` + `stopReason "output_delivered"`, no-`output`→text, missing skill, the `SteerCannotCarryStructuredOutput` reentrancy guard, and the **isolation** path (`isolate: true` runs on a fork, leaves the parent timeline untouched, disposes the child after settle)
- `@agentick/transport-in-process-next` `src/__tests__/wire-reads-e2e.spec.ts` — `skills/list` + `skills/get` (`content` included) round-trip over the real gateway + dynamic lane, `commands/list` enumerates them, undeclared verb stays MethodNotFound
- Cross-harness integration tests live in adopter packages (`@agentick/session-next`, `@agentick/app-next`)

## See also

- [Spec — `SkillsHarnessProtocol`](../spec/src/protocol/skills-harness.ts)
- [ADR 32 — Extension shape spectrum](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md)
- [`@agentick/compiler-react-next` `renderTemplate`](../compiler-react/README.md) — author skill `content` as JSX templates
