# Contributing to Agentick

Thank you for your interest in contributing to Agentick! This document provides guidelines and instructions for contributing.

Agentick is mid-rewrite. The stable v1 line lives under `packages/`; the v2 rewrite lives under `packages-next/` on the `feat/v2` branch and is where active development happens. Most contributions today target v2 — read the v2 pointers below before you start.

## AI-Assisted Development

We welcome contributions made with the help of AI coding assistants. When using AI tools:

### Guidelines

- **Quality standards apply equally** - AI-assisted code must meet the same quality bar as human-written code
- **Review AI output carefully** - Verify correctness, test thoroughly, and ensure the code follows our conventions
- **Understand what you submit** - Be able to explain and maintain any code you contribute
- **Run the full test suite** - AI-generated code must pass tests, typecheck, format, and lint (see [Verification gates](#verification-gates))

### AI Agent Resources

If you're an AI agent or using one:

- **Read `CLAUDE.md`** - The canonical codebase guide, including the v2 modularity model and the New Package Checklist
- **Read `AGENTS.md`** - The tight v2 entry doc for agents (booted every session)
- **Read `docs/proposals/v2/blueprint/`** - The architectural ADRs; start with `00-overview.md`, then `26-harness-api-shape.md` and `27-modular-built-ins.md`
- **Use `skills/`** - Task-scoped skills: `create-harness`, `create-extension` (v2); `create-component`, `create-hook`, `create-tool`, `create-adapter` (v1)

### Attribution

No special attribution is required for AI-assisted contributions. The standard commit and PR process applies.

---

## Development Setup

### Prerequisites

- Node.js 24+
- pnpm 10+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/agenticklabs/agentick.git
cd agentick

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Project Structure

```
agentick/
├── packages/            # v1 — stable published line (maintenance)
│   ├── core/           # agentick / @agentick/core
│   ├── kernel/         # @agentick/kernel - execution primitives
│   ├── shared/         # @agentick/shared - wire-safe types
│   ├── client/  react/  angular/  cli/  tui/
│   ├── gateway/  server/  express/  nestjs/
│   ├── devtools/  sandbox/  guardrails/  ...
│   └── adapters/       # @agentick/openai, google, ai-sdk
├── packages-next/       # v2 — active development (feat/v2 branch)
│   ├── spec/           # @agentick/spec-next - protocol seam (augmented by harnesses)
│   ├── runtime/  pubsub/  utils/          # foundation
│   ├── compiler/  compiler-react/         # JSX → IR compiler harness
│   ├── timeline/  knobs/  state/  gates/  tool/  resources/
│   │   elicitation/  tasks/  prompts/  skills/  subscriptions/  live/  credentials/
│   ├── tool-executor/  model-executor/  loop-executor/
│   ├── model/  model-ai-sdk/  model-anthropic/  model-openai/  model-google/
│   ├── session/  app/                     # session + app harnesses
│   ├── client/  client-core/  client-react/  client-extensions/
│   ├── transport*/  gateway/  cluster*/   # wire, gateway, clustering
│   └── sandbox*/  mcp/  connector/  eval/  formatters/  store/  telemetry-otlp/
├── example/             # Example applications (separate workspace)
│   ├── agent/          # v1 agent example
│   ├── express/  react/ # v1 server + client examples
│   ├── v2/  v2-real/    # v2 examples (v2-real is the canonical runnable reference)
│   └── v2-coding-agent/  v2-otto/  v2-otto-cluster/
└── website/            # Documentation website (VitePress)
```

v2 packages follow the `-next` naming law: `<role>-next` for a base/shared/abstract package, `<role>-<discriminator>-next` for a concrete impl (e.g. `compiler-next` base, `compiler-react-next` concrete). See `CLAUDE.md` for the full modularity model.

## Development Workflow

### Running in Development

```bash
# Watch mode across the workspace
pnpm dev

# Run the canonical v2 example
cp example/v2-real/.env.example example/v2-real/.env   # add your OPENAI_API_KEY
pnpm --filter example-v2-real dev
```

## Verification gates

These are the gates CI and the pre-commit hook enforce. Run them before opening a PR.

### Tests (vitest)

```bash
# v2 — run the whole packages-next tree from the repo root
npx vitest run packages-next

# Everything (v1 + v2 + tui)
pnpm test
```

Run vitest **from the repo root**, not with `pnpm --filter <pkg> test`. The per-package `--filter test` path is a turbo no-op that reports a false green — it does not actually run the suite. Always drive vitest at the root.

### Type checking

```bash
pnpm typecheck --force
```

`--force` bypasses turbo's cache so a stale green can't hide a real type error. Typecheck runs `tsc -p tsconfig.json --noEmit`, which **includes test files** — spec drift in fixtures is caught here, not by vitest (which strips types).

### Format & lint

```bash
pnpm format         # oxfmt --write .
pnpm format:check   # verify formatting (pre-commit hook)
pnpm lint           # oxlint
```

The formatter is **oxfmt** and the linter is **oxlint** — not prettier, not eslint-as-primary, not jest. The pre-commit hook runs `format:check` + `lint`.

### No top-level await

```bash
pnpm check:no-tla
```

Guards against top-level `await` in package sources, which breaks certain bundling targets.

### Building

```bash
pnpm build          # turbo build
pnpm clean          # remove build artifacts
```

## Code Style

### TypeScript

- Strict mode everywhere; typecheck (which includes tests) must be clean
- Prefer `type` imports for type-only imports: `import type { Foo } from "./foo.js"`
- Use explicit return types for public APIs
- Import from a package's index, not deep paths
- Single source of truth for types — one canonical definition, re-export elsewhere

### JSX

- v2 authoring uses React JSX (`jsx: "react-jsx"`, `jsxImportSource: "react"`); the compiler-react harness renders it to model context
- Use `.tsx` for files with JSX
- Prefer semantic components (`<H1>`, `<Paragraph>`, `<List>`, …) over raw markdown strings

### Naming Conventions

- **Files**: kebab-case (`create-tool.ts`)
- **Classes**: PascalCase (`CompilerHarness`)
- **Functions**: camelCase (`createApp`)
- **Types/Interfaces**: PascalCase (`SessionHarnessProtocol`)
- **v2 packages**: `-next` suffix per the naming law above

### Exports

- Named exports (avoid default exports)
- Re-export from `index.ts`
- `export type` for type-only exports

## Pull Request Process

### Before Submitting

1. **Create an issue first** for significant changes
2. **Create a feature branch** (no worktrees)
3. **Write tests** for new functionality — every user-facing claim is backed by a test
4. **Update documentation** — package READMEs and, for v2, `docs/proposals/v2/STATUS.md`
5. **Run the verification gates** above and ensure they pass

### PR Guidelines

- Clear, descriptive titles
- Reference related issues
- One feature/fix per PR
- CI must pass before review

### Commit Messages

Follow conventional commits (enforced by commitlint):

```
feat: add streaming support to the loop executor
fix: resolve memory leak in the pubsub bus
docs: update the harness authoring skill
chore: upgrade dependencies
refactor: simplify tool execution
test: add conformance coverage for knobs
```

## Package Guidelines

### Adding a New Package

New v2 packages go under `packages-next/` and must follow the **New Package Checklist in `CLAUDE.md`** (package scaffold, changeset linked list, typedoc entry points, website package groups, README, `pnpm install`). Every new package ships a README (purpose, usage, API, status, roadmap, known gaps).

### Package Dependencies

- Use `workspace:*` for internal dependencies
- Keep external dependencies minimal
- When adding a cross-package import, declare the dependency in the host package's `package.json` and run a workspace-wide `pnpm typecheck --force` before committing

## Testing Guidelines

### Test Structure

```typescript
describe("FeatureName", () => {
  describe("methodName", () => {
    it("does something specific", () => {
      const input = createInput();
      const result = methodName(input);
      expect(result).toBe(expected);
    });
  });
});
```

Spec files are named `*.spec.ts` / `*.spec.tsx`. A harness package's tests live with the harness: `harness.spec.ts` (harness-only), `conformance.spec.ts`, and `integration-with-compiler.spec.tsx` (real `CompilerHarness`). Cross-harness integration tests live in `@agentick/session-next` or the metapackage.

### Test doubles (Meszaros taxonomy)

Name test doubles by role, per Meszaros' _xUnit Test Patterns_:

- `fake*` — minimal working implementations (the default)
- `stub*` — canned answers
- `spy*` — call recorders
- `mock*` — expectation checkers

Never `test*` — it collapses the taxonomy. Every layer ships its doubles under a `/testing` subpath (e.g. `@agentick/knobs-next/testing`), typed against the spec interfaces so a spec change breaks stale doubles at compile time. Before writing a new helper, grep the package's `src/` (and `@agentick/utils-next` + its `/testing`) for an existing one.

## Documentation

### Code Documentation

- JSDoc on public APIs; cite the test that verifies a claim with `@verifiedBy`
- Document only constraints the code can't show — not narration

### Package READMEs

Each package ships a README with description, usage example, API reference (or link to docs), status, roadmap, and known gaps. Unverified claims live under "Roadmap & known gaps," never as silent prose.

## Questions?

- Open an issue for bugs or feature requests
- Use discussions for questions and ideas
- Read `CLAUDE.md` (codebase guide) and `AGENTS.md` (agent entry doc)

Thank you for contributing!
