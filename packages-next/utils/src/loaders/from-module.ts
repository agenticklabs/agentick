/**
 * `sourceFromModule` — dynamic-import a module specifier and pick records
 * from its exports.
 *
 * This is the ONE source that preserves functions (handlers, `render`
 * callbacks, `use()` hooks) across the load boundary. Use it for record
 * types that carry code — prompts with `render`, tools with `handler`,
 * skills authored as JSX templates.
 *
 * The `picker` callback receives the full module namespace (as `unknown`
 * — the loader does not enforce a schema) and returns the records.
 * Common patterns:
 *
 *  - **Single default export:** `(mod) => [(mod as any).default]`
 *  - **Named export collection:** `(mod) => (mod as any).prompts ?? []`
 *  - **Convention-based scan:** `(mod) => Object.values(mod).filter(isPromptDecl)`
 *
 * The picker may return a value, an array, or undefined (yielding zero
 * records). Errors during import propagate.
 */

import type { Loader } from "./loader.js";

export interface FromModuleOptions<T> {
  readonly specifier: string;
  readonly picker: (
    module: unknown,
  ) => readonly T[] | T | undefined | Promise<readonly T[] | T | undefined>;
  /** Dynamic-import override — useful for bundler-specific resolution. */
  readonly import?: (specifier: string) => Promise<unknown>;
}

export function sourceFromModule<T>(options: FromModuleOptions<T>): Loader<T> {
  return {
    load: async () => {
      const importer = options.import ?? ((s: string) => import(s));
      const mod = await importer(options.specifier);
      const picked = await options.picker(mod);
      if (picked == null) return [];
      return Array.isArray(picked) ? (picked as readonly T[]) : [picked as T];
    },
  };
}
