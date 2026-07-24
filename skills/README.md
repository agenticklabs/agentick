# Skills

Task-scoped skills for working in this repo. Invoke the one that matches what you are building.

The repo is mid-rewrite: v2 lives under `packages-next/` (`feat/v2`), v1 under `packages/` (stable). Skills are scoped accordingly.

## v2 skills (author here)

| Skill                  | Use for                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`create-harness`**   | A new v2 harness — `BaseHarness` subclass with substrate, protocol, `HookBridges` augmentation, `withX()` extension, conformance suite, optional `/react` + `/testing` subpaths. Lives at `skills/create-harness/`. |
| **`create-extension`** | The adopter-facing entry: routes to a harness, a compiler contributor, or a descriptor-only React surface, for local or published extensions. Lives at `skills/create-extension/`.                                  |

## v1 skills (stable `packages/` line)

These are symlinks into the v1 package trees; they describe v1 APIs (`@agentick/core`, `@agentick/adapters`) and the `packages/` scaffold.

| Skill              | Target                                            | Scope |
| ------------------ | ------------------------------------------------- | ----- |
| `create-component` | `packages/core/.agents/skills/create-component`   | v1    |
| `create-hook`      | `packages/core/.agents/skills/create-hook`        | v1    |
| `create-tool`      | `packages/core/.agents/skills/create-tool`        | v1    |
| `create-adapter`   | `packages/adapters/.agents/skills/create-adapter` | v1    |

For a **v2** tool, use `createTool` from `@agentick/tool-next` (the `create-harness` / `create-extension` skills cover where it fits); for a v2 model adapter, see the `@agentick/model-executor-next` base + `@agentick/model-*-next` packages.

## Cross-cutting skills

Symlinks into `.agents/skills/`; each carries a v2-gate banner at the top for `feat/v2` work.

| Skill             | Use for                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `add-package`     | Scaffold a new workspace package (v2 → `packages-next/` per the New Package Checklist in `CLAUDE.md`). |
| `build-and-check` | Run the verification gates (v2: root vitest, `typecheck --force`, oxfmt/oxlint, `check:no-tla`).       |
| `test-agent`      | Write agent tests (v2: the Meszaros `/testing` doubles law).                                           |
