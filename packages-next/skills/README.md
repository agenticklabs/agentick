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
  readonly name: string;          // unique within the harness; snake_case convention
  readonly description: string;   // one-line summary for retrieval / listing
  readonly content: string;       // full body — markdown / prose / recipe
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>; // adopter-defined
  readonly updatedAt: number;     // wall-clock ms
  readonly createdAt: number;
}
```

Skills are first-class data. The harness treats them as opaque content; the agent's prompt design decides what to do with them. Authoring `content` via `renderTemplate` from `@agentick/reconciler-react-next` (JSX → markdown string) is the recommended pattern for richer skill bodies.

## API — `SkillsHandle` on `session.skills`

| Method | Async? | Effect |
|--------|--------|--------|
| `get(name)` | sync | Read by exact name; `undefined` if missing |
| `has(name)` | sync | Existence check |
| `list()` | sync | All skills (no filter) |
| `search({ query?, tagsAny?, tagsAll?, limit? })` | sync | Filtered subset. `query` matches `name` + `description` (case-insensitive substring in reference impl); `tagsAny` is OR, `tagsAll` is AND |
| `register({ name, description, content, tags?, metadata? })` | async | Create. Throws `{_tag: "SkillAlreadyExists"}` on duplicate name |
| `update({ name, description?, content?, tags?, metadata? })` | async | Patch fields. Throws `{_tag: "SkillNotFound"}` if missing |
| `remove({ name })` | async | Delete. Throws `{_tag: "SkillNotFound"}` if missing |
| `subscribe(name, listener)` | sync | Listen for a specific skill's mutations |
| `subscribeAll(listener)` | sync | Listen for any mutation |

Reads are cheap and synchronous (no envelopes). Mutations go through `runOperation` — every `register` / `update` / `remove` produces `requested → terminal` envelopes on the session's bus that the model, admins, or audit tooling can observe.

Failures are typed:

```ts
type SkillsError =
  | { _tag: "SkillNotFound"; name: string }
  | { _tag: "SkillAlreadyExists"; name: string }
  | { _tag: "SkillsBackendError"; cause: unknown };
```

## Inbox addressing

The harness is inbox-addressable at `skills:{scopeId}`. Adopters needing cross-harness coordination can route messages via the inbox:

```ts
await inbox.send({ addressedTo: "skills:s_42", type: "skills:register", payload: { ... } });
```

## Backend swap

The reference `SkillsHarness` keeps skills in memory (with snapshot/restore). The protocol is backend-agnostic — `SkillsHarnessProtocol` in `@agentick/spec-next` defines the shape; alternative implementations slot in:

- **`SqliteSkillsHarness`** (planned) — durable single-process backend; survives process restart without snapshot/restore plumbing.
- **`RemoteSkillsHarness`** (planned) — `agentskills.io`-compatible remote registry; cross-session, cross-process library.

Backend lives in the harness instance — `withSkills({ ... })` constructs the reference impl. Adopters wanting a different backend register their own `SessionExtension` that swaps in their `SkillsHarness` subclass.

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

Cross-harness integration testing — when verifying that skills interact correctly with the reconciler, session, or other harnesses — uses `runSkillsHarnessConformance` against the real protocol surface.

## Status & roadmap

**Shipped:**
- `SkillsHarness` reference impl (in-memory, journal-backed)
- `withSkills` session-extension factory
- Conformance suite (`runSkillsHarnessConformance`)
- `/testing` subpath with `stubSkillsHarness`
- Module augmentation: `session.skills` typed via `SkillsHandle`

**Planned:**
- SQLite backend for single-process durability
- Remote-registry backend (`agentskills.io` compatibility)
- Embedding-based search (currently substring-only)
- Skill versioning / history

**Known gaps:**
- Search is substring-only on `name` + `description`. Adopters who need richer retrieval supply a custom harness backend.
- No transaction support across multiple mutations — each `register`/`update`/`remove` is its own Operation.
- No per-skill ACL — all session participants share one library.

## Verified by

- `src/__tests__/harness.spec.ts` — full conformance suite + sync/async surface + envelope flow + snapshot round-trip + inbox routing
- Cross-harness integration tests live in adopter packages (`@agentick/session-next`, `@agentick/app-next`)

## See also

- [Spec — `SkillsHarnessProtocol`](../spec/src/protocol/skills-harness.ts)
- [ADR 32 — Extension shape spectrum](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md)
- [`@agentick/reconciler-react-next` `renderTemplate`](../reconciler-react/README.md) — author skill `content` as JSX templates
