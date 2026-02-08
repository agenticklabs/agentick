# Contributing to Agentick

Thank you for your interest in contributing to Agentick! This document provides guidelines and instructions for contributing.

## AI-Assisted Development

We welcome contributions made with the help of AI coding assistants. When using AI tools:

### Guidelines

- **Quality standards apply equally** - AI-assisted code must meet the same quality bar as human-written code
- **Review AI output carefully** - Verify correctness, test thoroughly, and ensure the code follows our conventions
- **Understand what you submit** - Be able to explain and maintain any code you contribute
- **Run the full test suite** - AI-generated code must pass all tests: `pnpm test`

### AI Agent Resources

If you're an AI agent or using one:

- **Read `CLAUDE.md`** - Overview of the codebase for AI agents
- **Check `ARCHITECTURE.md` files** - Each package has detailed architecture docs
- **Use `CONVENTIONS.md`** - Naming and coding standards
- **Use testing utilities** - `@agentick/shared/testing` provides fixtures and helpers

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
git clone https://github.com/rlindgren/agentick.git
cd agentick

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Project Structure

```
agentick/
├── packages/           # Published packages
│   ├── core/          # agentick - Core framework
│   ├── kernel/        # @agentick/kernel - Execution primitives
│   ├── client/        # @agentick/client - Browser client
│   ├── express/       # @agentick/express - Express middleware
│   ├── server/        # @agentick/server - Server utilities
│   ├── react/         # @agentick/react - React bindings
│   ├── angular/       # @agentick/angular - Angular bindings
│   └── adapters/      # AI provider adapters
│       ├── ai-sdk/    # @agentick/ai-sdk
│       ├── openai/    # @agentick/openai
│       └── google/    # @agentick/google
├── example/           # Example applications (separate workspace)
│   ├── backend/       # Express backend example
│   ├── frontend-react/    # React frontend example
│   └── frontend-angular/  # Angular frontend example
└── website/           # Documentation website (VitePress)
```

## Development Workflow

### Running in Development

```bash
# Watch mode for a specific package
cd packages/core
pnpm dev

# Run the example app
cd example
pnpm install
pnpm dev:backend    # Terminal 1
pnpm dev:frontend   # Terminal 2
```

### Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter agentick test

# Run tests in watch mode
pnpm --filter agentick test -- --watch

# Run a specific test file
pnpm --filter agentick test -- src/engine/engine.spec.ts
```

### Type Checking

```bash
# Type check all packages
pnpm typecheck

# Type check a specific package
pnpm --filter agentick typecheck
```

### Building

```bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter agentick build

# Clean build artifacts
pnpm clean
```

## Code Style

### TypeScript

- Use TypeScript for all code
- Enable strict mode
- Prefer `type` imports for type-only imports: `import type { Foo } from './foo'`
- Use explicit return types for public APIs

### JSX

- The core package uses a custom JSX runtime (`agentick/jsx-runtime`)
- React/Angular packages use their respective JSX runtimes
- Use `.tsx` extension for files with JSX

### Naming Conventions

- **Files**: kebab-case (`engine-client.ts`)
- **Classes**: PascalCase (`EngineClient`)
- **Functions**: camelCase (`createEngine`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_TIMEOUT`)
- **Types/Interfaces**: PascalCase (`EngineConfig`)

### Exports

- Use named exports (avoid default exports)
- Re-export from `index.ts` files
- Use `export type` for type-only exports

## Pull Request Process

### Before Submitting

1. **Create an issue first** for significant changes
2. **Fork the repository** and create a feature branch
3. **Write tests** for new functionality
4. **Update documentation** if needed
5. **Run the full test suite** and ensure it passes
6. **Run type checking** and fix any errors

### PR Guidelines

- Use clear, descriptive PR titles
- Reference related issues in the description
- Keep PRs focused - one feature/fix per PR
- Ensure CI passes before requesting review

### Commit Messages

Follow conventional commits:

```
feat: add streaming support to engine
fix: resolve memory leak in channel client
docs: update getting started guide
chore: upgrade dependencies
refactor: simplify tool execution logic
test: add integration tests for hooks
```

## Package Guidelines

### Adding a New Package

1. Create the package directory under `packages/`
2. Initialize with standard structure:
   ```
   packages/new-package/
   ├── src/
   │   └── index.ts
   ├── package.json
   ├── tsconfig.json
   ├── tsconfig.build.json
   └── tsconfig.spec.json
   ```
3. Add to `pnpm-workspace.yaml` if needed
4. Add package README

### Package Dependencies

- Use `workspace:*` for internal dependencies
- Keep external dependencies minimal
- Document peer dependencies clearly

## Testing Guidelines

### Test Structure

```typescript
describe("FeatureName", () => {
  describe("methodName", () => {
    it("should do something specific", () => {
      // Arrange
      const input = createTestInput();

      // Act
      const result = methodName(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

### Test Types

- **Unit tests**: Test individual functions/classes in isolation
- **Integration tests**: Test interactions between components
- **Spec files**: Named `*.spec.ts` or `*.spec.tsx`

### Mocking

- Use Jest's built-in mocking
- Reset mocks in `beforeEach`
- Prefer dependency injection for testability

## Documentation

### Code Documentation

- Add JSDoc comments to public APIs
- Include examples in documentation
- Document complex logic with inline comments

### Package READMEs

Each package should have a README with:

- Package description
- Installation instructions
- Basic usage example
- API reference (or link to docs)

## Testing Utilities

Use the testing utilities from `@agentick/shared/testing` for consistent test patterns:

```typescript
import {
  createUserMessage,
  createAssistantMessage,
  createToolUseBlock,
  createTextStreamSequence,
  captureAsyncGenerator,
  waitFor,
} from "@agentick/shared/testing";

describe("MyFeature", () => {
  it("should handle messages", async () => {
    const message = createUserMessage("Hello");
    const result = await processMessage(message);
    expect(result).toBeDefined();
  });
});
```

See `packages/shared/ARCHITECTURE.md` for the full list of available utilities.

## Questions?

- Open an issue for bugs or feature requests
- Use discussions for questions and ideas
- Check `CLAUDE.md` for codebase overview (helpful for AI agents too!)

Thank you for contributing!
