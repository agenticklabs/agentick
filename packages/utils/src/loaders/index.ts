/**
 * `@agentick/utils/loaders` — primitive plumbing for harness-specific
 * record loaders.
 *
 * This subpath ships the platform-agnostic primitives:
 *  - `Loader<T>` + `mergeLoaders` / `mapLoader` (composition)
 *  - `sourceFromArray` (literal records)
 *  - `sourceFromUrl` (fetch-based; function-free records only)
 *  - `sourceFromModule` (dynamic-import; preserves functions)
 *  - `extractFrontmatter` (delimiter-block scanner — no YAML/TOML parse)
 *
 * For filesystem sources, import from `@agentick/utils/loaders/node`.
 * That subpath is intentionally separate so the main loaders module
 * works in any JS environment (browser, edge runtime, bundler).
 *
 * Harness packages (`@agentick/skills`, `@agentick/prompts`)
 * compose these primitives into record-typed public `fromX` APIs. The
 * set of sources sound for a record type depends on whether it carries
 * unserializable code; that constraint is harness-specific, not
 * primitive-level.
 */

export { type Loader, mergeLoaders, mapLoader } from "./loader.js";
export { sourceFromArray } from "./from-array.js";
export { sourceFromUrl, type FromUrlOptions } from "./from-url.js";
export { sourceFromModule, type FromModuleOptions } from "./from-module.js";
export {
  extractFrontmatter,
  type ExtractFrontmatterResult,
  type ExtractFrontmatterOptions,
} from "./frontmatter.js";
