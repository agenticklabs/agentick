/**
 * `SkillLoader` — Skill-shaped `Loader<SkillsRegisterInput>` factories.
 *
 * Composes the primitives in `@agentick/utils/loaders` with a
 * Skill-shaped parser:
 *  - `fromArray(skills)` — literal records (the trivial case)
 *  - `fromUrl(url, ...)` — JSON manifest with `skills: SkillsRegisterInput[]`
 *  - `fromManifest(url, ...)` — alias for `fromUrl` with shipped-default conventions
 *
 * Filesystem sources live in the `/node` subpath because `node:fs` is
 * Node-only — see [`./loaders/node.ts`](./loaders/node.ts).
 *
 * Skill records are entirely string-based (`name`, `description`,
 * `content`), so every source is sound for skills — unlike prompts,
 * which have a function-carrying subset (`render`) that only survives
 * `sourceFromModule`.
 */

import type { SkillsRegisterInput } from "@agentick/spec";
import type { Loader } from "@agentick/utils/loaders";
import { sourceFromArray, sourceFromUrl } from "@agentick/utils/loaders";

export type SkillLoader = Loader<SkillsRegisterInput>;

/**
 * Wrap an in-memory array as a `SkillLoader`. Use for bundled starter
 * skills shipped with an app.
 */
export function fromArray(skills: readonly SkillsRegisterInput[]): SkillLoader {
  const base = sourceFromArray(skills);
  return {
    load: base.load,
    lookup: async (name) => skills.find((s) => s.name === name) ?? null,
  };
}

export interface FromUrlOptions {
  readonly url: string | URL;
  /** Override the global `fetch` (tests, custom dispatchers). */
  readonly fetch?: typeof fetch;
  readonly init?: RequestInit;
  /** Custom statuses to accept as success. Default: `response.ok`. */
  readonly acceptStatuses?: readonly number[];
  /**
   * Field on the JSON body that carries the skill array. Default
   * `"skills"`. Pass `null` to treat the entire body as the array.
   */
  readonly arrayField?: string | null;
}

/**
 * Fetch a JSON manifest at `url`. The response body must be either:
 *  - an object with `{ "skills": SkillsRegisterInput[] }` (default), OR
 *  - a top-level `SkillsRegisterInput[]` (set `arrayField: null`).
 *
 * No schema validation — adopters who need it wrap the loader in
 * `mapLoader` with a validator. The point of this factory is the
 * common case.
 */
export function fromUrl(options: FromUrlOptions): SkillLoader {
  const field = options.arrayField === undefined ? "skills" : options.arrayField;
  const inner = sourceFromUrl<SkillsRegisterInput>({
    url: options.url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.init ? { init: options.init } : {}),
    ...(options.acceptStatuses ? { acceptStatuses: options.acceptStatuses } : {}),
    parse: async (response) => {
      const body = (await response.json()) as unknown;
      if (field === null) {
        if (!Array.isArray(body)) {
          throw new Error(`skills.fromUrl: ${String(options.url)} did not yield an array`);
        }
        return body as readonly SkillsRegisterInput[];
      }
      if (body == null || typeof body !== "object" || !(field in body)) {
        throw new Error(`skills.fromUrl: ${String(options.url)} response missing "${field}" field`);
      }
      const arr = (body as Record<string, unknown>)[field];
      if (!Array.isArray(arr)) {
        throw new Error(`skills.fromUrl: ${String(options.url)} "${field}" field is not an array`);
      }
      return arr as readonly SkillsRegisterInput[];
    },
  });
  return {
    load: inner.load,
    lookup: async (name) => {
      const all = await inner.load();
      return all.find((s) => s.name === name) ?? null;
    },
  };
}

/**
 * Alias for `fromUrl` — same shape, named to read better at the call
 * site when the URL is an explicit "skills manifest" endpoint.
 */
export const fromManifest = fromUrl;
