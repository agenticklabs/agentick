/**
 * Workspace + mount management for the local provider.
 *
 * Creates/destroys the temp workspace root and resolves declared
 * {@link SandboxMount}s (host ↔ sandbox path pairs) into realpath-resolved
 * {@link ResolvedMount}s the path-confinement layer trusts.
 */

import { access, mkdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SandboxMountError } from "@agentick/sandbox-next";
import type { SandboxMount } from "@agentick/sandbox-next";

/** A mount whose host path has been validated + realpath-resolved. */
export interface ResolvedMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readOnly: boolean;
}

/**
 * Create the workspace directory.
 *
 * @param workspace explicit path, `true`/`undefined` → auto temp dir
 * @param tmpBase   base dir for auto temp workspaces (default: os.tmpdir())
 */
export async function createWorkspace(
  workspace: string | true | undefined,
  tmpBase: string = tmpdir(),
): Promise<{ path: string; autoCreated: boolean }> {
  if (workspace === true || workspace === undefined) {
    const id = randomBytes(8).toString("hex");
    const raw = join(tmpBase, `agentick-sandbox-${id}`);
    await mkdir(raw, { recursive: true, mode: 0o700 });
    // Always realpath (e.g. macOS /var → /private/var) so confinement checks match.
    return { path: await realpath(raw), autoCreated: true };
  }
  await mkdir(workspace, { recursive: true });
  return { path: await realpath(workspace), autoCreated: false };
}

/** Destroy an auto-created workspace. Never removes user-specified dirs. */
export async function destroyWorkspace(path: string, autoCreated: boolean): Promise<void> {
  if (!autoCreated) return;
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[sandbox-local-next] failed to destroy workspace ${path}:`, err);
  }
}

/** Resolve a single declared mount, validating the host path exists. */
export async function resolveMount(mount: SandboxMount): Promise<ResolvedMount> {
  try {
    await access(mount.hostPath, constants.R_OK);
  } catch (cause) {
    throw new SandboxMountError({
      hostPath: mount.hostPath,
      sandboxPath: mount.sandboxPath,
      reason: "host path not accessible",
      cause,
    });
  }
  return {
    hostPath: await realpath(mount.hostPath),
    sandboxPath: mount.sandboxPath,
    readOnly: mount.readOnly ?? false,
  };
}

/** Resolve an initial set of declared mounts. */
export async function resolveMounts(
  mounts: readonly SandboxMount[] = [],
): Promise<ResolvedMount[]> {
  const resolved: ResolvedMount[] = [];
  for (const mount of mounts) resolved.push(await resolveMount(mount));
  return resolved;
}
