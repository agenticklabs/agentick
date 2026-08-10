/**
 * `fakeMountStore(seed)` — a working in-memory {@link MountStore} for tests and
 * for `runResourceMountConformance`. Keys are internal (the store never sees a
 * model-facing address); `listChildren` matches by internal-key prefix.
 */

import type { ResourceContents } from "@agentick/spec";
import type { Child, MountStore, Page } from "../mounts.js";

export interface MountSeed {
  /** internal leaf key → text body. */
  readonly leaves: Readonly<Record<string, string>>;
  /** internal directory prefix → its children. */
  readonly children: Readonly<Record<string, readonly Child[]>>;
  /** internal directory prefix → the cursor its first page reports. */
  readonly cursors?: Readonly<Record<string, string>>;
}

export function fakeMountStore(seed: MountSeed): MountStore {
  return {
    async get(key): Promise<readonly ResourceContents[] | undefined> {
      const text = seed.leaves[key];
      return text === undefined ? undefined : [{ uri: key, mimeType: "text/markdown", text }];
    },
    async listChildren({ prefix, cursor }): Promise<Page<Child>> {
      const entries = seed.children[prefix] ?? [];
      const next = cursor === undefined ? seed.cursors?.[prefix] : undefined;
      return next === undefined ? { entries } : { entries, cursor: next };
    },
  };
}
