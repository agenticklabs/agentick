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
  "version": "0.1.0",
  "description": "Description of the package",
  "keywords": ["agent", "ai"],
  "license": "MIT",
  "author": "Ryan Lindgren",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/agenticklabs/agentick.git",
    "directory": "packages/my-package"
  },
  "files": ["dist"],
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      }
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "echo \"Tests run from workspace root\"",
    "typecheck": "tsc -p tsconfig.build.json --noEmit",
    "clean": "rm -rf dist tsconfig.build.tsbuildinfo",
    "prepublishOnly": "pnpm build",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@agentick/kernel": "workspace:*",
    "@agentick/shared": "workspace:*"
  }
}
```

3. Create `packages/my-package/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo",
    "composite": true
  },
  "include": [],
  "references": [{ "path": "./tsconfig.build.json" }]
}
```

4. Create `packages/my-package/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "tsBuildInfoFile": "dist/.tsbuildinfo.build"
  },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts", "src/**/__tests__"]
}
```

5. Create `packages/my-package/src/index.ts`:

```typescript
export { myFunction } from "./my-module.js";
export type { MyType } from "./types.js";
```

6. **Add to changeset linked list** — `.changeset/config.json`:

Add `"@agentick/my-package"` to the `linked[0]` array so it's version-coordinated with other packages.

7. **Add to TypeDoc** — `website/typedoc.json`:

Add `"../packages/my-package"` to the `entryPoints` array for API docs generation.

8. **Add to website package groups** — `website/.vitepress/config.mts`:

Add `"@agentick/my-package"` to the appropriate group in the `PACKAGE_GROUPS` array.

9. **Create README** — `packages/my-package/README.md`:

Write a README following the style of existing packages. Include: Purpose, Quick Start, API reference, Patterns.

10. Install and verify:

```bash
pnpm install
pnpm --filter @agentick/my-package typecheck
pnpm typecheck  # verify no cross-package issues
```

## Dependency Layers

Respect the package hierarchy:

- **Foundation** (`kernel`, `shared`): No agentick dependencies
- **Core** (`core`): Depends on kernel, shared
- **Framework** (`gateway`, `client`, `server`, `express`, `devtools`, `sandbox`): Depends on core/kernel/shared
- **Adapters** (`openai`, `google`, `ai-sdk`): Depends on core, shared
- **Applications**: Depends on anything

## Conventions

- Package names: `@agentick/my-package`
- Source in `src/`, tests as `*.spec.ts` siblings or in `__tests__/`
- Single `index.ts` barrel export per package
- Use `workspace:*` for internal dependencies
- TypeScript strict mode
- ESM only (`"type": "module"`)
- Build with `tsc` (not tsup)
- Two tsconfigs: `tsconfig.json` (references) + `tsconfig.build.json` (includes src, excludes tests)

## Key Files

- Workspace config: `pnpm-workspace.yaml`
- Root tsconfig: `tsconfig.json`
- Changeset config: `.changeset/config.json`
- TypeDoc config: `website/typedoc.json`
- Website config: `website/.vitepress/config.mts`
- Existing packages: `packages/*/package.json`
