/**
 * `sourceFromFile` / `readFrontmatterFile` — Node `fs`-backed file loaders.
 *
 * `sourceFromFile` reads ONE file and yields its raw text in a one-element
 * batch. Pair with {@link mapLoader} to deserialize.
 *
 * `readFrontmatterFile` is a one-shot helper that reads + parses out the
 * frontmatter block (delimiter scan only — no YAML/TOML parse, see
 * {@link extractFrontmatter}). Returns the file path alongside so the
 * caller can include it in the typed record.
 */

import { readFile } from "node:fs/promises";

import { extractFrontmatter, type ExtractFrontmatterOptions } from "../frontmatter.js";
import type { Loader } from "../loader.js";

export interface FileRecord {
  readonly path: string;
  readonly content: string;
}

export interface FrontmatterFileRecord extends FileRecord {
  readonly frontmatter: string | null;
  readonly body: string;
}

export interface FromFileOptions {
  readonly path: string;
  readonly encoding?: BufferEncoding;
}

export function sourceFromFile(options: FromFileOptions): Loader<FileRecord> {
  const encoding = options.encoding ?? "utf-8";
  return {
    load: async () => {
      const content = await readFile(options.path, encoding);
      return [{ path: options.path, content }];
    },
  };
}

export async function readFrontmatterFile(
  path: string,
  options: ExtractFrontmatterOptions & { encoding?: BufferEncoding } = {},
): Promise<FrontmatterFileRecord> {
  const content = await readFile(path, options.encoding ?? "utf-8");
  const { frontmatter, body } = extractFrontmatter(content, options);
  return { path, content, frontmatter, body };
}
