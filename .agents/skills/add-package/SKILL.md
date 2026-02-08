---
name: add-package
description: Add a new package to the agentick monorepo. Use when creating a new @agentick/* package.
---

# Add a Package

Agentick is a pnpm workspace monorepo. New packages go in `packages/`.

## Steps

1. Create the package directory:

```bash
mkdir -p packages/my-package/src
```

2. Create `packages/my-package/package.json`:

```json
{
  "name": "@agentick/my-package",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "main": "dist/index.js",
    "types": "dist/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      }
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentick/kernel": "workspace:*",
    "@agentick/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "tsup": "catalog:",
    "vitest": "catalog:"
  }
}
```

3. Create `packages/my-package/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

4. Create `packages/my-package/src/index.ts`:

```typescript
// Public API exports
export { myFunction } from "./my-module";
export type { MyType } from "./types";
```

5. Add subpath exports if needed:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  }
}
```

6. Install and verify:

```bash
pnpm install
pnpm --filter @agentick/my-package typecheck
```

## Dependency Layers

Respect the package hierarchy:

- **Foundation** (`kernel`, `shared`): No agentick dependencies
- **Core** (`core`): Depends on kernel, shared
- **Framework** (`gateway`, `client`, `server`, `express`, `devtools`): Depends on core/kernel/shared
- **Adapters** (`openai`, `google`, `ai-sdk`): Depends on core, shared
- **Applications**: Depends on anything

## Conventions

- Package names: `@agentick/my-package`
- Source in `src/`, tests as `*.spec.ts` siblings or in `__tests__/`
- Single `index.ts` barrel export per package
- Use `workspace:*` for internal dependencies
- TypeScript strict mode
- ESM only (`"type": "module"`)

## Key Files

- Workspace config: `pnpm-workspace.yaml`
- Base tsconfig: `tsconfig.base.json`
- Existing packages: `packages/*/package.json`
