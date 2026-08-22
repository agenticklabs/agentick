---
name: create-extension
description: Adopter-facing entry skill for extending agentick. Routes to the right path based on what the user is actually trying to build — a new session-scoped or app-scoped harness (knobs/state-style), a compiler contributor (formatter, content-block parser, semantic component), or a descriptor-only React surface (gates-style). Handles both local-in-app extensions and published `@my-org/agentick-thing` packages. Delegates harness mechanics to `create-harness`.
---

# Create a v2 Extension

This skill helps an adopter add a new capability to agentick — something that extends the compiler or the session beyond the built-in primitives. "Extension" is the consumer-facing word; depending on what you're building, the implementation might be a harness, a compiler contributor, or a descriptor-only React surface.

The skill's job is:

1. **Ask the right clarifying questions** so the user lands on the right shape
2. **Route to the right path** (harness, contributor, descriptor-only)
3. **Handle both local-in-app and published-package modes**
4. **Delegate harness mechanics to `create-harness`** rather than duplicating the deep walk

If you (the agent running this skill) end up building a harness, **read `skills/create-harness/SKILL.md` end-to-end** — that's the mechanical content. This skill stays at the routing + adopter-ergonomics layer.

## Required reading before routing

You need enough architectural context to route correctly. Read in order:

1. **`docs/proposals/v2/blueprint/26-harness-api-shape.md`** — "Harness as the single shape." Clarifies that extensions are harnesses architecturally.
2. **`docs/proposals/v2/blueprint/27-modular-built-ins.md`** — Built-ins are bundled, not privileged. Same pattern for adopter extensions.
3. **The skill description for `create-harness`** — so you know what you'll delegate to.

Don't deep-read every adopter reference before clarifying — you'll do that after the routing question is answered.

## Clarify with the user before writing anything

Open the conversation by confirming three things. Use `AskUserQuestion` if running interactively; otherwise ask in chat. **Do not skip this step** — picking the wrong shape costs the user an hour of refactoring.

### Question 1 — What are you extending?

| Option                                                                                     | When                                                                  | Goes to path                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------- |
| "I want new model-visible state or commands the agent can dispatch"                        | Knobs-style: model writes/reads, audit envelopes, optional UI         | **Harness path**                            |
| "I want a long-lived resource per session (sandbox provider, MCP connection, scheduler)"   | Per-session lifecycle, may need shared app-level pool                 | **Harness path** (with app+session pair)    |
| "I want to render something new in the model's context (custom format, new content block)" | Compiler-side: format markdown differently, parse a new content block | **Contributor path**                        |
| "I want a new React hook that exposes existing state in a different shape"                 | No new state owner — just a different view of existing bridges        | **Hook-only path** (consume `useBridges()`) |
| "I want a model-visible gate-style descriptor without a backing harness"                   | Gates-style: declare a descriptor, React reads it                     | **Descriptor-only path**                    |

If the user can't pick, ask: "Does the thing need to publish audit envelopes, accept inbox messages, or own substrate participation?" If yes → harness path. If no → one of the other three.

### Question 2 — Local-in-app or published package?

| Option                                   | When                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local** (default for proof-of-concept) | Just for this app. Inline files under `src/extensions/` in the adopter's project. No npm publishing. Faster iteration.                                                                  |
| **Published**                            | Adopters outside the project should install it. Goes through full ADR 27 package layout: `sideEffects`, dual subpaths, peerDeps, changeset/typedoc/vitepress if it joins the workspace. |
| **Local now, graduate later**            | Start local; promote to a published package once it stabilizes. Most common for non-trivial extensions.                                                                                 |

If unsure, default to **local now, graduate later**. Cheaper to start; the mechanical work to graduate is documented at the end of this skill.

### Question 3 — Does it ship a React surface?

| Option  | When                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Yes** | Adopters consume it from JSX (`useMyThing()`, `<MyThing />`). Most common for harness extensions.                                      |
| **No**  | Pure server-side capability (background scheduler, log shipper). Adopters consume it through `session.myThing` or via direct dispatch. |

If yes, the package needs an optional `react` peer dep and a `/react` subpath (published) or a colocated `react.tsx` file (local).

---

## Path A — Harness extension

This is the most common path. You're building a new session-scoped (or app-scoped) capability that owns substrate participation.

### Local mode (in adopter's app)

Skip the published-package mechanics; do the harness in two or three files inside the adopter's project.

```
my-app/
  src/
    extensions/
      my-thing/
        harness.ts        ← BaseHarness<"my-thing"> subclass
        augment.ts        ← declare module "@agentick/spec"
        extension.ts      ← withMyThing() SessionExtension
        index.ts          ← re-exports; imports ./augment for side effect
        react.ts          ← (optional) useMyThing() hook
```

The mechanical content for each of these files is exactly what `create-harness` documents. **Read `skills/create-harness/SKILL.md` for the harness, augmentation, extension factory, and `/react` patterns.** The only differences in local mode:

- **No `package.json`.** Files live directly in the adopter's `tsconfig` include path.
- **No `sideEffects` directive needed.** The adopter imports `./extensions/my-thing/index.js` directly in their app's entry; bundlers see explicit consumption and won't tree-shake.
- **No conformance suite required** (but recommended — your tests get to use the standard pattern).
- **No `/testing` subpath needed.** The adopter writes their tests against the harness directly.
- **The protocol can live local.** Either inline in `harness.ts` or in a sibling `protocol.ts`. Use the local-protocol variant from `create-harness` step "Local protocol variant."

Hand-off note when delegating to `create-harness`: tell it the user wants **local mode**, skip the package skeleton + registration steps, focus on the harness/augment/extension/react/test patterns.

### Published mode

Full `create-harness` walk applies. Workspace package if joining `@agentick/*`; standalone `@my-org/agentick-thing` otherwise.

If joining the workspace, the user is contributing to agentick. Tell them about the New Package Checklist in `CLAUDE.md` and run through it.

If standalone, the only meaningful differences from a workspace package are:

- `package.json` deps point at real semver ranges (`"@agentick/spec": "^x.y.z"`), not `workspace:*`
- No changeset/typedoc/vitepress steps
- Adopter installs via `pnpm add @my-org/agentick-thing`

The `sideEffects` discipline, dual subpaths, optional react peer dep, and module augmentation work identically. Stress this — it's a common stumble.

---

## Path B — Compiler contributor

You're adding a render-time capability: a new formatter scope, a new content-block contributor, a semantic component renderer. No substrate. No audit envelopes. No inbox.

### Required reading

- **`packages/compiler/src/collect/contributors/`** — the existing contributors (semantic HTML, content blocks, formatters)
- **`packages/compiler-react/README.md`** — the compiler-react surface
- **`packages/spec/src/protocol/contributor.ts`** — Contributor protocol if it exists at spec level

### Local mode

A contributor is usually just a function or object passed to the compiler config. For example:

```ts
// my-app/src/extensions/my-formatter.tsx
import type { Contributor } from "@agentick/compiler";

export const myFormatter: Contributor = {
  name: "my-formatter",
  // ... contributor-specific shape
};

// then in the app setup:
createApp(<Agent />, {
  contributors: [myFormatter, ...],
});
```

The exact shape depends on the contributor type. Read the existing contributors in `packages/compiler/src/collect/contributors/` for the canonical shapes.

### Published mode

A package that exports a contributor. No `sideEffects` complexity (no module augmentation needed unless the contributor introduces new typed shapes). Standard package layout:

```
@my-org/agentick-my-formatter/
  package.json
  src/
    index.ts          ← exports the contributor
    formatter.tsx     ← implementation
```

No harness. No augmentation. No conformance suite. Much simpler than Path A.

---

## Path C — Hook-only (no new state owner)

You're not extending the framework — you're consuming existing bridges in a new shape. Example: a `useKnobOrDefault(id, fallback)` that wraps `useKnob` with a default-value pattern.

This isn't really a framework extension; it's just an adopter-defined hook. Use `create-hook` if needed. No skill content here beyond "write the hook in your app, no package needed."

If the user landed here, gently steer them: "This sounds like a regular React hook, not a framework extension. Want me to use `create-hook` instead?"

---

## Path D — Descriptor-only React surface

Gates-style. You declare typed descriptors (e.g., feature flags, capability hints) and adopters read them from React. No backing harness, no substrate.

### Required reading

- **`packages/gates/`** — the canonical reference. Read every file. It's small.
  - `src/descriptor.ts` — descriptor type
  - `src/index.ts` — exports
  - `src/react/` — the React hook
- **`docs/proposals/v2/blueprint/27-modular-built-ins.md`** — gates is mentioned as the counter-example to "every extension needs a harness"

### Local mode

```
my-app/
  src/
    extensions/
      my-flags/
        descriptor.ts     ← typed descriptor + maker function
        react.ts          ← useMyFlag(name) hook
        index.ts
```

The descriptor is plain data. The hook is a regular React hook (probably consuming `useBridges().knobs` or similar). No augmentation unless you want typed slots on a bridge.

### Published mode

Standard package shape. No `sideEffects` for augmentation unless you augment a bridge. Usually small (a few files).

---

## Graduating local → published

Common path: adopter built a local extension, wants to publish it. The graduation checklist:

1. **Move files** from `my-app/src/extensions/my-thing/` to `@my-org/agentick-my-thing/src/`.
2. **Write `package.json`** with the canonical shape from `create-harness` step "Package skeleton." Critically:
   - Add `sideEffects` array including `augment.ts` + `augment.js`
   - Add optional `react` peer dep if you ship a React surface
   - Split out `/react` and `/testing` into proper subpath exports
3. **Add `import "./augment.js";` to `src/index.ts`** if not already there. Local mode often gets away without it because the app entry imports the module file directly; published mode needs the explicit side-effect import.
4. **Write a conformance suite.** Required for published packages — the conformance suite IS the public contract.
5. **Write a `/testing` subpath** with a stub factory.
6. **Write a README** (Purpose, Quick Start, API, Patterns).
7. **`pnpm install`** in the new package and in any consumer.
8. **Update the adopter's app** to import from `@my-org/agentick-my-thing` instead of `./extensions/my-thing/`. The augmentation key (slot name on `HookBridges`) stays identical — the bridge consumer code doesn't change.

If the package joins the agentick workspace, also: changeset linked list, typedoc entry points, vitepress PACKAGE_GROUPS (see `CLAUDE.md` New Package Checklist).

---

## Verification (independent of path)

Before declaring done, the user should be able to:

1. **Install the extension in a fresh session** and see it appear (`session.myThing` or `useMyThing()` works)
2. **Trigger the capability** end-to-end (mutate state, run a tool, render the contributor)
3. **Observe envelopes** on the bus (`session.events({ surface: "my-thing" })`) — only applies to harness path
4. **Run conformance + tests** green — only applies to published path
5. **Checkpoint round-trip** (`persist` → `hydrate`) preserves state — only if the harness implements `CheckpointCapable` over its own store

For UI extensions, start the dev server and exercise the feature in a browser before declaring done. Type checks and unit tests verify code correctness, not feature correctness.

---

## Common adopter pitfalls

These bite adopters specifically (in addition to the `create-harness` pitfalls):

1. **Local mode forgets the side-effect import.** They import `MyThingHarness` but never import `./augment.js`. Slot isn't registered; `useMyThing()` crashes at runtime. Fix: always import the package root (`./extensions/my-thing/index.js`), not the harness file directly.

2. **Confusing extension with contributor.** Adopter wants to render a custom block but builds a harness for it. Wasted effort — they should be on Path B. Always run Question 1.

3. **Building a harness for a feature flag.** Flag value is static or set-once; doesn't need substrate. Should be Path D (descriptor-only) or just a constant. Always ask: "Does it mutate? Does the audit trail matter?"

4. **Forgetting to wait for `harness.ready`.** Local mode's `install` function is the adopter's responsibility. They forget to await; first call drops; nothing happens. Stress this when teaching local mode.

5. **Trying to depend on `@agentick/compiler-react` from a non-React surface.** Per ADR 27, your harness package depends on `@agentick/compiler-react` only via the `/react` subpath. The base package must work without React.

6. **Skipping conformance because "it's just my app."** Local mode survives this. Published mode does not — the moment another adopter installs your package, conformance is the contract. Run it from day one.

---

## Decision summary you'll arrive at

After clarifying with the user, you'll have:

|                              | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| Path                         | A (harness) / B (contributor) / C (hook-only) / D (descriptor-only) |
| Mode                         | Local / Published / Local-now-graduate-later                        |
| React surface                | Yes / No                                                            |
| App-scoped or session-scoped | App / Session / Both                                                |
| Durable state (own store)    | Yes / No                                                            |
| Conformance suite            | Required (published) / Recommended (local)                          |

Capture these in your first message back to the user as a checklist of what you'll build. Then go.

---

## When to use `create-harness` instead of this skill

If the user explicitly says "I want to build a new harness" (or is contributing to the agentick workspace and knows the vocabulary), skip this skill and use `create-harness` directly. This skill exists to handle the routing question — once it's answered, `create-harness` does the heavy lifting.

If the user says "I want to customize the existing timeline storage" (or knobs, state, etc.), this is the future `customize-[harness]` family. Until those skills exist, route to `create-harness` Step "Customizing an existing harness instead" — same mechanical content with the protocol-exists shortcut applied.
