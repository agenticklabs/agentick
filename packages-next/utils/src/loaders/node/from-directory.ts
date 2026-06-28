/**
 * `sourceFromDirectory` — recursive directory walk yielding file records.
 *
 * Walks `path` depth-first via `fs.readdir({ withFileTypes: true,
 * recursive: false })`. Symbolic links are NOT followed (avoid cycles +
 * adopter-surprise traversal of host filesystem). Hidden entries (names
 * starting with `.`) are skipped by default — opt in with
 * `includeHidden: true`.
 *
 * Filtering happens via `match` (RegExp or predicate). When `match` is
 * a RegExp, it tests `entry.name` (NOT the full path) — same semantics
 * as `glob` extensions.
 *
 * Each yielded `FileRecord` carries the absolute path and the file's
 * raw text content. Callers compose with {@link mapLoader} to extract
 * frontmatter, parse YAML/TOML/JSON, or build a typed record.
 *
 * For huge directories: the loader resolves with the full batch — no
 * streaming. If that's a concern, partition into multiple loaders
 * (e.g., one per top-level subdirectory) and `mergeLoaders` them.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Loader } from "../loader.js";
import type { FileRecord } from "./from-file.js";

export interface FromDirectoryOptions {
  readonly path: string;
  readonly recursive?: boolean;
  readonly includeHidden?: boolean;
  readonly match?: RegExp | ((entry: { name: string; path: string }) => boolean);
  readonly encoding?: BufferEncoding;
}

export function sourceFromDirectory(options: FromDirectoryOptions): Loader<FileRecord> {
  const recursive = options.recursive ?? true;
  const includeHidden = options.includeHidden ?? false;
  const encoding = options.encoding ?? "utf-8";
  const matcher = compileMatcher(options.match);

  return {
    load: async () => {
      const out: FileRecord[] = [];
      const stack: string[] = [options.path];

      while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch (cause) {
          throw new Error(`sourceFromDirectory: readdir failed on ${current}: ${String(cause)}`, {
            cause,
          });
        }

        for (const entry of entries) {
          if (!includeHidden && entry.name.startsWith(".")) continue;
          // Skip symlinks — they may point anywhere.
          if (entry.isSymbolicLink()) continue;
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            if (recursive) stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (matcher && !matcher({ name: entry.name, path: full })) continue;
          const content = await readFile(full, encoding);
          out.push({ path: full, content });
        }
      }

      // Stable ordering — directories are popped in reverse insertion order
      // by the stack. Sort by path so adopters get deterministic output.
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
  };
}

function compileMatcher(
  m: FromDirectoryOptions["match"],
): ((entry: { name: string; path: string }) => boolean) | null {
  if (!m) return null;
  if (m instanceof RegExp) return (entry) => m.test(entry.name);
  return m;
}
