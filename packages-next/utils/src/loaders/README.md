# `@agentick/utils-next/loaders`

Primitive plumbing for harness-specific record loaders. Two subpaths:

- `@agentick/utils-next/loaders` — platform-agnostic primitives
- `@agentick/utils-next/loaders/node` — Node `fs`-backed sources

Each harness package (`@agentick/skills-next`, `@agentick/prompts-next`, future `@agentick/resources-next`) composes these primitives into its OWN public `fromArray / fromFile / fromDirectory / ...` API. The set of sources that's _sound_ for a record type depends on whether the record carries unserializable code — that constraint is harness-specific, so this module deliberately does NOT ship a unified `from*` surface.

## Why this exists

Three kinds of loaders exist in this codebase, and they have different constraints:

| Kind                      | What it loads                                                        | Sources that work                                               |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Content-as-string**     | Skill body, MCP resource, static-template prompt                     | array / url / file / directory / manifest — anything            |
| **Declaration-with-code** | Prompt with `render(args)`, Tool with `handler`, React JSX templates | array / module **only** — functions don't survive serialization |
| **Hybrid**                | Prompt with `template` OR `render`                                   | depends per-record on whether code is present                   |

A single `Loader<T>` interface with `fromArray / fromUrl / fromFile / fromDirectory / fromModule` factories would lie about that: it would imply all sources work for all records. They don't. So we ship the _primitives_ here and let each harness expose the source subset that's sound.

## The `Loader<T>` contract

```ts
interface Loader<T> {
  readonly load: () => Promise<readonly T[]>;
}
```

That's it. One call returns the full batch. Streaming is deliberately not part of v1 — partition into multiple loaders + `mergeLoaders` if you need it.

## Primitives — `@agentick/utils-next/loaders`

| Primitive                                                    | Purpose                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `Loader<T>`                                                  | The contract — `{ load(): Promise<readonly T[]>, lookup?(name): Promise<T \| null> }` |
| `mergeLoaders(...ls): Loader<T>`                             | Concatenate loader outputs in input order (runs concurrently)                         |
| `mapLoader(loader, fn): Loader<B>`                           | Transform records lazily; `null`/`undefined` returns drop the record                  |
| `sourceFromArray<T>(items): Loader<T>`                       | Literal records — the trivial source                                                  |
| `sourceFromUrl<T>({ url, parse, ... }): Loader<T>`           | `fetch`-based; function-free records only                                             |
| `sourceFromModule<T>({ specifier, picker, ... }): Loader<T>` | Dynamic `import()`; preserves functions across the boundary                           |
| `extractFrontmatter(text): { frontmatter, body }`            | Delimiter-block scanner (`---` … `---`). No YAML/TOML parse — caller picks            |

Both source primitives accept dependency-injection escapes (`fetch` / `import`) for tests and bundler-specific resolution.

## Node primitives — `@agentick/utils-next/loaders/node`

Separate subpath because importing `node:fs` from the main entry would break browser / edge-runtime usage of the rest of `utils-next`.

| Primitive                                                                                          | Purpose                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sourceFromFile({ path, encoding? }): Loader<FileRecord>`                                          | Read one file; yields `{ path, content }`                                       |
| `readFrontmatterFile(path, opts?)`                                                                 | One-shot: read + delimiter-scan — yields `{ path, content, frontmatter, body }` |
| `sourceFromDirectory({ path, recursive?, match?, includeHidden?, encoding? }): Loader<FileRecord>` | Recursive walk; deterministic sort; skips hidden + symlinks by default          |

`match` accepts a `RegExp` (tested against `entry.name`) or a `({ name, path }) => boolean` predicate.

## Usage pattern — harness composes a typed `fromX`

A harness package wires its parser onto these primitives:

```ts
// in @agentick/skills-next
import { mapLoader, sourceFromArray, extractFrontmatter } from "@agentick/utils-next/loaders";
import { sourceFromDirectory } from "@agentick/utils-next/loaders/node";
import type { Skill } from "@agentick/spec-next";

export const fromArray = (skills: readonly Skill[]) => sourceFromArray(skills);

export const fromDirectory = (path: string) =>
  mapLoader(sourceFromDirectory({ path, match: /\.md$/ }), ({ path, content }) => {
    const { frontmatter, body } = extractFrontmatter(content);
    if (!frontmatter) return null;
    const meta = parseYamlOrTomlOrWhatever(frontmatter); // skills' choice
    return { name: meta.name, description: meta.description, content: body } satisfies Skill;
  });
```

Same skeleton in `@agentick/prompts-next`, except its `fromDirectory` is omitted (JSX `.tsx` files on disk need a bundler), and `fromModule` exists so React-authored prompts compose.

## Composing sources

```ts
import { mergeLoaders } from "@agentick/utils-next/loaders";

const all = mergeLoaders(
  skills.fromArray(bundled),
  skills.fromDirectory("./skills/"),
  skills.fromUrl("https://registry.internal/skills.json"),
);
const batch = await all.load(); // concatenated, in input order
```

If ANY underlying loader rejects, `merge.load()` rejects too — there is no per-source isolation. Wrap each loader (`{ load: () => l.load().catch(() => []) }`) if you need silent fallback behavior, but the explicit recommendation is to let it propagate.

## Constraints (the boundaries this module enforces)

- **Functions can only cross `sourceFromModule`.** Anything that needs serialization (URL, file, directory) yields bytes, which become typed records only after a `mapLoader` transform. If your record type has `render(args) => ReactNode`, you cannot load it from a URL.
- **No global state, no caching.** Each `load()` call re-reads the source. Memoization is the caller's choice — if you want it, wrap the loader.
- **No watch / subscribe.** Loaders are pull-based snapshots. Live-reload is a separate concern (handle via your harness's `register/update/remove` after the initial load).
- **Symlinks are skipped** in directory walks. Cross-volume traversal and cycles aren't worth the foot-gun.
- **`lookup(name)` is OPTIONAL.** Loaders that can answer "do you have X" without enumerating the whole batch implement it; harnesses use it as the fast-path during lookup-on-miss reads. Loaders without `lookup` fall back to `load()` + filter on the harness side — same correctness, worse perf.

## Verified by

- `__tests__/loaders.spec.ts` — 22 tests covering all platform-agnostic primitives + composition
- `__tests__/node.spec.ts` — 12 tests covering Node fs sources (tmpdir-backed)

## Status

**Shipped:**

- Platform-agnostic primitives (5)
- Node fs primitives (3)
- Frontmatter delimiter scan (no YAML/TOML parse — by design)
- Composition (`mergeLoaders` / `mapLoader`)

**Planned:**

- None at the primitive layer. Future work — manifest loaders, watch-mode, paginated URL traversal — belongs in harness-specific packages.

**Known gaps:**

- `extractFrontmatter` only handles a single delimiter block at the start. Multi-block (e.g., `---\nmeta1\n---\n...\n---\nmeta2\n---\n...`) is not in scope.
- No URL-pagination helper. If you need it, write your own `Loader<T>` that calls `fetch` in a loop.
