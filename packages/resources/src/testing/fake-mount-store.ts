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
}

export function fakeMountStore(seed: MountSeed): MountStore {
  return {
    async get(key): Promise<readonly ResourceContents[] | undefined> {
      const text = seed.leaves[key];
      return text === undefined ? undefined : [{ uri: key, mimeType: "text/markdown", text }];
    },
    async listChildren(prefix): Promise<Page<Child>> {
      return { entries: seed.children[prefix] ?? [] };
    },
  };
}
