# ADR 71 — Application workspace conventions + `agentick.config.ts`

**Status:** DRAFT 2026-07-09 (Fable, for Ryan — decisions ratified in a design workshop; NOT yet
built). **Builds on:** ADR 27 (bundled built-ins / the `agentick` metapackage), ADR 31 (harness
hierarchy), ADR 34 (`mergeLayered` cascade primitive), ADR 42 (the `withX` trichotomy), ADR 68
(the app-scoped `tasks: { store, executors }` injection seam), the `reconciler-react-next` binding.
**Workshop artifact:** the four decisions below were resolved live; this ADR is their record.

## TL;DR

Adopters need a canonical project layout (the Rails/Angular/Next "convention over configuration"
payoff) and a defaults layer the framework + its tooling read. This ADR fixes:

- **Workspace-default layout** — a monorepo of apps, migration-free as it grows.
- **Five convention folders** — `agents/ tools/ skills/ prompts/ resources/` — a convention for
  humans + tooling; loading stays **explicit** (index barrels, optionally codegen'd). **No
  runtime folder scan.**
- **`agentick.config.ts`** — an executable-TS defaults + registry layer, resolved by
  `mergeLayered`, with profiles + an `extends` chain; lazy for runtime resources.
- **`create-agentick-app`** — a bootstrapper with `--framework` selecting the agent-authoring
  reconciler binding.

## Decisions

### 1. Workspace-default (not single-app-default)

`create-agentick-app my-bot` scaffolds a workspace with `apps/my-bot/` already in it (nesting hidden
by the bootstrapper). **Why, beyond preference:** workspace-always is the _migration-free_ choice.
Single-app-default forces a restructure — move the app into `apps/`, add turbo/pnpm plumbing,
re-path imports — exactly when the second app arrives. Workspace-always never restructures: you add
`apps/second/`. **Growth must never cost a restructure.**

```
acme-agents/
├─ apps/{support-bot,research-agent}/   # each app = the per-app shape below
├─ packages/{tools,skills,domain}/      # shared across apps
├─ clients/web/                         # optional human UI (SEPARATE framework axis)
├─ gateway/                             # optional standalone serving process
├─ agentick.config.ts                   # workspace defaults + model registry
├─ pnpm-workspace.yaml  turbo.json
```

Per app: `src/{agent.tsx, agents/, tools/, skills/, prompts/, resources/, knobs.ts, gates.ts,
app.ts, serve.ts}` + a local `agentick.config.ts` that `extends` the workspace.

### 2. Five convention folders — explicit loading, NOT runtime magic

`agents/ tools/ skills/ prompts/ resources/` are known by name so files land in the right place and
tooling can find them. But **loading is explicit** — an index barrel (`tools/index.ts` re-exports
each) imported in `app.ts`, exactly as the v1 example already did. Runtime magic-scan (glob at boot,
load whatever's there) is **rejected** — it's a footgun at scale: untraceable loads, stray/scratch
files registered, ambiguous order, no conditional include, silent behavior change on file move.
Optional ergonomic: the CLI **codegen's** the barrel (scan → a committed `*.generated.ts` you can
inspect — the "typed routes" pattern), which is explicit-and-inspectable, not a runtime scan. So
`discovery` in the config = "where the **tooling/codegen** looks," never "what the runtime loads."

### 3. `agentick.config.ts` — the defaults + registry layer

It earns a file for exactly three kinds of thing: what **tooling** needs before running the app
(discovery, the CLI), workspace-wide **defaults**, and **registries** apps resolve by name. Runtime
wiring (the specific model instance, this app's extensions) stays in `app.ts`, which resolves names
_from_ the config. It is **not** a mirror of `createApp`.

```ts
export default defineAgentickConfig({
  framework: "react", // §4 binding
  discovery: {
    agents: "src/agents",
    tools: "src/tools",
    skills: "src/skills",
    prompts: "src/prompts",
    resources: "src/resources",
  },
  models: () => ({ default: aisdk(openai("gpt-4o-mini")), smart: aisdk(anthropic("...")) }),
  tasks: () => ({ store: postgresTaskStore({ executor: pool }) }), // ADR 68 seam
  timeline: () => ({ store: postgresTimelineStore({ executor: pool }) }), // session persistence
  elicitation: { defaultTimeoutMs: 120_000 },
  defaults: { maxTicks: 50, devTools: true },
  serve: { transport: "ws", port: 4000 },
  env: { OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" }, // binding, NOT the secret
  extends: "../..", // (app) inherit the workspace config
  profiles: {
    dev: {
      /*…*/
    },
    prod: {
      /*…*/
    },
  },
  apps: "apps/*", // (workspace shape only)
});
```

**Lazy by rule:** the config is executable TS, but `models`/`tasks`/`timeline` are **thunks** — so
`agentick dev` reads `discovery`/`apps`/`framework` (static meta) without constructing model
clients or a DB pool (which need secrets/network). Static meta eager; runtime resources lazy.

**Resolution = a `mergeLayered` cascade** (ADR 34 primitive, already in `@agentick/utils`:
later-overrides-earlier, `undefined` falls through, `append`/`replace` modifiers) — no bespoke
merge code. Layers, least→most specific:

```
framework defaults → workspace config → app config (extends) → selected profile → AGENTICK_* env → CLI flags
```

**Multiple configs** (three flavors, all merged by the same primitive): `profiles` in one file ·
separate `agentick.config.<name>.ts` files · an `extends` chain (workspace→app). **Selector
precedence** (highest wins): `--config <path>` > `AGENTICK_CONFIG`/`AGENTICK_PROFILE` > `NODE_ENV` >
the default file. (`Loader`/`mergeLoaders` in `utils/loaders` composes the sources.)

### 4. `--framework` = the agent-authoring reconciler binding

`create-agentick-app --framework react|angular|solid` selects which **reconciler binding** you
author agents in (`reconciler-react-next` today; Angular/Solid are sibling bindings over one core
IR — the framework-agnostic-reconciler direction). The **client UI** is a _separate axis_ (a
distinct `--client` flag / the `clients/` dir), so a React-authored agent can be served to an
Angular UI over the wire. Everything below the reconciler — harnesses, model adapters, gateway,
transports, tools — is framework-neutral; only the agent surface changes.

## `create-agentick-app`

Scaffolds the workspace (+ first app), wires `package.json` to the metapackage + the chosen model
adapter + the chosen reconciler binding, writes `agentick.config.ts`, and drops a working agent +
tool + `.env.example`. Flags (all promptable): `--framework` · `--template` · `--model` ·
`--extensions` (withX to pre-wire) · `--serve local|gateway`.

## Rejected

- **Runtime folder magic-scan** — footgun at scale (see §2). Explicit barrels / codegen instead.
- **Single-app default** — forces a restructure at app #2 (see §1).
- **Config as a `createApp` mirror** — two sources of truth. Config is defaults + registry;
  `app.ts` resolves + overrides.
- **Data-only (non-executable) config** — loses typed adapter instances + autocomplete; the
  lazy-thunk rule gives tooling cheap static reads without going data-only.

## Open (implementation — a future build)

- `defineAgentickConfig` types + the `mergeLayered`-based loader (profiles / `extends` / selector).
- The index-barrel codegen + the `agentick` CLI (`dev` / `build` / `add app`).
- Does the **store + executor dual-slot** pattern (ADR 68 tasks) generalize enough that the config
  should model it uniformly across layers (timeline has a store only; tasks has both)? Suspected
  recurring shape — validate against ≥3 layers before formalizing (steel-man the null hypothesis).
- The `clients/` + `--client` axis (human-facing UI) — ties into the native UI-rendering seam
  (`ui://` resources + MCP-Apps/AG-UI projections) being workshopped separately.

@see the workshop artifact (workspace-structure) for the rendered proposal + the resolved-decision log.
