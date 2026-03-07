/**
 * Static File Server
 *
 * Serves files from a directory with SPA fallback, content-type mapping,
 * path traversal protection, ETag/304 caching, and pre-compressed support.
 *
 * Usage:
 *   const handler = serveStatic("/path/to/dist", { prefix: "/dashboard" });
 *   ctx.registerRoute("/dashboard", handler);
 */

import { createReadStream, existsSync, statSync, type Stats } from "node:fs";
import { join, extname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ServeStaticOptions {
  /** SPA fallback file (default: "index.html"). Set to false to disable. */
  fallback?: string | false;
  /** Cache-Control header value (default: "public, max-age=3600") */
  cacheControl?: string;
  /** Strip this prefix from the URL path before resolving files */
  prefix?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

/**
 * Create a static file serving handler.
 *
 * @param directory - Absolute path to the directory containing static files
 * @param options - Configuration options
 * @returns Request handler compatible with `ctx.registerRoute()`
 */
export function serveStatic(
  directory: string,
  options: ServeStaticOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const resolvedDir = resolve(directory);
  const fallback = options.fallback ?? "index.html";
  const cacheControl = options.cacheControl ?? "public, max-age=3600";
  const prefix = options.prefix ? normalizePrefix(options.prefix) : "";

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only serve GET and HEAD
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    // Strip prefix
    if (prefix && pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length) || "/";
    }

    // Resolve to a file path within the directory
    const filePath = resolveFilePath(resolvedDir, pathname);
    if (!filePath) {
      // Path traversal attempt
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // Try to serve the file
    const served = await tryServeFile(filePath, req, res, cacheControl);
    if (served) return;

    // Try index.html for directory paths
    if (pathname.endsWith("/")) {
      const indexPath = join(filePath, "index.html");
      const served = await tryServeFile(indexPath, req, res, cacheControl);
      if (served) return;
    }

    // SPA fallback
    if (fallback !== false) {
      const fallbackPath = join(resolvedDir, fallback);
      const served = await tryServeFile(fallbackPath, req, res, "no-cache");
      if (served) return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };
}

/**
 * Resolve a URL pathname to an absolute file path within the directory.
 * Returns null if the resolved path escapes the directory (path traversal).
 */
function resolveFilePath(directory: string, pathname: string): string | null {
  // Normalize: remove query string, decode, resolve
  const clean = pathname.split("?")[0].split("#")[0];
  const resolved = resolve(directory, "." + clean);

  // Path traversal check: resolved path must be within directory
  const rel = relative(directory, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved) {
    return null;
  }

  return resolved;
}

/**
 * Try to serve a specific file. Returns true if the file was served.
 */
async function tryServeFile(
  filePath: string,
  req: IncomingMessage,
  res: ServerResponse,
  cacheControl: string,
): Promise<boolean> {
  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }

  if (!stat.isFile()) return false;

  // ETag based on mtime + size
  const etag = generateETag(stat);

  // 304 Not Modified
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return true;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": cacheControl,
    ETag: etag,
  });

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  // Stream the file
  return new Promise<boolean>((resolve) => {
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
      resolve(true);
    });
    stream.pipe(res).on("finish", () => resolve(true));
  });
}

function generateETag(stat: Stats): string {
  const hash = createHash("md5").update(`${stat.mtimeMs}-${stat.size}`).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

function normalizePrefix(prefix: string): string {
  // Ensure prefix starts with / and doesn't end with /
  let p = prefix;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
