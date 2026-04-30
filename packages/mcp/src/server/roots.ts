/**
 * Roots — server-side handle for the client's declared filesystem
 * boundaries (`roots/list`).
 *
 * @module @agentick/mcp/server/roots
 */

import * as path from "node:path";
import type { Root, RootsAPI } from "../protocol/types.js";

// ============================================================================
// Path utilities
// ============================================================================

/**
 * Convert a `file://` URI to an absolute POSIX-style filesystem path.
 * Decodes percent-escapes. Returns the input unchanged if it doesn't
 * have a `file://` prefix.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  // Strip the scheme + authority. We treat `file:///x` and `file://x` as
  // path-only — no support for remote authorities (file://host/...) since
  // the spec doesn't model those. The leading `/` after `file://` is part
  // of the path itself in `file:///abs` form, so we leave it intact.
  const stripped = uri.slice("file://".length);
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/** Return the absolute filesystem path for a root, decoded. */
export function rootPath(root: Root): string {
  return fileUriToPath(root.uri);
}

/**
 * Check whether a candidate path is inside a root path. Boundary-aware:
 * `/workspace` does NOT contain `/workspace-other`. The candidate may
 * equal the root exactly.
 */
export function pathIsWithin(candidate: string, rootAbsPath: string): boolean {
  // Normalize both paths to remove trailing slashes and resolve `..`.
  const norm = path.posix.normalize(candidate);
  const root = path.posix.normalize(rootAbsPath);

  if (norm === root) return true;

  // Boundary check — candidate must start with root + path separator.
  const sep = root.endsWith("/") ? "" : "/";
  return norm.startsWith(root + sep);
}

/**
 * Validate that a root URI is acceptable per MCP spec 2025-11-25:
 * MUST be `file://`. Returns true when the URI conforms.
 */
export function isValidRootUri(uri: unknown): uri is string {
  return typeof uri === "string" && uri.startsWith("file://");
}

// ============================================================================
// RootsAPI implementation
// ============================================================================

/**
 * Internal source contract — owned by `MCPServer`. Provides cached
 * roots access and notification-driven invalidation/refresh hooks.
 */
export interface RootsSource {
  fetchRoots(): Promise<Root[]>;
  onRootsChanged(listener: (roots: Root[]) => void): () => void;
}

/**
 * Concrete `RootsAPI` bound to a single session. Wraps the `RootsSource`
 * (which encapsulates the cached fetch + notification fan-out) and
 * implements the path utilities on top.
 */
export class RootsAPIImpl implements RootsAPI {
  constructor(private readonly source: RootsSource) {}

  async list(): Promise<Root[]> {
    return this.source.fetchRoots();
  }

  async isWithin(candidate: string): Promise<boolean> {
    const roots = await this.source.fetchRoots();
    if (roots.length === 0) return true; // permissive default
    const candidatePath = fileUriToPath(candidate);
    return roots.some((r) => pathIsWithin(candidatePath, rootPath(r)));
  }

  async assertWithin(candidate: string): Promise<void> {
    const roots = await this.source.fetchRoots();
    if (roots.length === 0) return; // no constraints declared
    const candidatePath = fileUriToPath(candidate);
    const allowed = roots.some((r) => pathIsWithin(candidatePath, rootPath(r)));
    if (!allowed) {
      throw new Error(
        `Path '${candidatePath}' is outside all declared roots: ${roots
          .map((r) => rootPath(r))
          .join(", ")}`,
      );
    }
  }

  async rootContaining(candidate: string): Promise<Root | null> {
    const roots = await this.source.fetchRoots();
    if (roots.length === 0) return null;
    const candidatePath = fileUriToPath(candidate);

    // Pick the longest-prefix match for nested roots
    let best: Root | null = null;
    let bestLen = -1;
    for (const r of roots) {
      const rp = rootPath(r);
      if (pathIsWithin(candidatePath, rp) && rp.length > bestLen) {
        best = r;
        bestLen = rp.length;
      }
    }
    return best;
  }

  async resolveRelative(relativePath: string, opts?: { name?: string }): Promise<string> {
    const roots = await this.source.fetchRoots();
    if (roots.length === 0) {
      throw new Error("Cannot resolveRelative: no roots declared by the client");
    }

    let target: Root | undefined;
    if (opts?.name) {
      target = roots.find((r) => r.name === opts.name);
      if (!target) {
        throw new Error(
          `No root named '${opts.name}' (available: ${roots
            .map((r) => r.name ?? rootPath(r))
            .join(", ")})`,
        );
      }
    } else {
      target = roots[0];
    }
    return path.posix.join(rootPath(target!), relativePath);
  }

  subscribe(listener: (roots: Root[]) => void): () => void {
    return this.source.onRootsChanged(listener);
  }
}
