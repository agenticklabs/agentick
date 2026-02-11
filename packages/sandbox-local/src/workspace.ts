/**
 * Workspace Management
 *
 * Create, validate, and destroy workspace directories. Resolve mounts
 * from SandboxCreateOptions into host-path ResolvedMounts.
 */

import { mkdir, rm, access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Mount } from "@agentick/sandbox";
import type { ResolvedMount } from "./executor/types";

/**
 * Create a workspace directory.
 *
 * @param workspace - Explicit path, or `true` for auto-generated temp dir
 * @param tmpBase - Base directory for temp workspaces (default: os.tmpdir())
 * @returns Object with the workspace path and whether it was auto-created
 */
export async function createWorkspace(
  workspace: string | true | undefined,
  tmpBase: string = tmpdir(),
): Promise<{ path: string; autoCreated: boolean }> {
  if (workspace === true || workspace === undefined) {
    const id = randomBytes(8).toString("hex");
    const raw = join(tmpBase, `agentick-sandbox-${id}`);
    await mkdir(raw, { recursive: true, mode: 0o700 });
    // Always return realpath'd (e.g. macOS /var → /private/var)
    return { path: await realpath(raw), autoCreated: true };
  }

  // Explicit path — ensure it exists
  await mkdir(workspace, { recursive: true });
  return { path: await realpath(workspace), autoCreated: false };
}

/**
 * Destroy a workspace directory.
 * Only removes auto-created workspaces (safety: never delete user-specified dirs).
 */
export async function destroyWorkspace(path: string, autoCreated: boolean): Promise<void> {
  if (!autoCreated) return;

  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[sandbox-local] Failed to destroy workspace ${path}:`, err);
  }
}

/**
 * Resolve mounts from user-specified Mount[] to ResolvedMount[].
 * Validates that host paths exist and are accessible.
 */
export async function resolveMounts(mounts: Mount[] = []): Promise<ResolvedMount[]> {
  const resolved: ResolvedMount[] = [];

  for (const mount of mounts) {
    // Validate host path exists
    try {
      await access(mount.host, constants.R_OK);
    } catch {
      throw new Error(`Mount host path not accessible: ${mount.host}`);
    }

    const hostPath = await realpath(mount.host);

    resolved.push({
      hostPath,
      sandboxPath: mount.sandbox,
      mode: mount.mode ?? "rw",
    });
  }

  return resolved;
}
