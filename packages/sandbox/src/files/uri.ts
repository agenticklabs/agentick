/**
 * `file://` URI ↔ path helpers + a minimal extension→mime guesser for
 * the sandbox↔MCP projections (ADR 65). Node-only — this subpath is a
 * server-side adapter (deps mcp + resources), never bundled to a browser.
 *
 * The path helpers wrap `node:url` so `file://` round-trips are correct
 * across platforms (drive letters, percent-encoding, spaces). The mime
 * guesser is deliberately tiny: it covers the common text-vs-binary split
 * a filesystem projection needs, and falls back to `application/octet-stream`
 * for the unknown — an honest "I don't know," not a fabricated type.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { extname } from "node:path";

/** Encode an absolute filesystem path as a canonical `file://` URI. */
export function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}

/** Decode a `file://` URI back to a filesystem path. */
export function fileUriFromPath(uri: string): string {
  return fileURLToPath(uri);
}

/**
 * Extension→mime map. Small on purpose: a filesystem projection only
 * needs the common cases plus an honest fallback. `null` from
 * {@link isTextMime} for anything outside the text set.
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

/** Text mime prefixes/exact-types the file-resolver treats as UTF-8 text. */
const TEXT_MIME = new Set<string>([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/toml",
  "image/svg+xml",
]);

/**
 * Guess a mime type from a path's extension. Falls back to
 * `application/octet-stream` for the unknown (honest "don't know").
 */
export function guessMimeType(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * True iff a mime type is UTF-8 text (any `text/*` or a known
 * text-shaped application type). Drives the text-vs-blob degrade in the
 * file-resolver.
 */
export function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_MIME.has(mimeType);
}
