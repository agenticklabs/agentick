/**
 * In-VM filesystem operations for the sandbox-agent (ADR 60).
 *
 * The far-side implementation of the {@link SandboxHandle}'s `readFile` /
 * `writeFile` / `editFile` ops, run INSIDE the microVM against the local
 * workspace filesystem. `editFile` runs the shared, crown-jewel `applyEdits`
 * transform (re-exported from `@agentick/sandbox`) IN-VM and writes back
 * atomically — one hop, no client-side read→edit→write round-trip.
 *
 * Path confinement is defence-in-depth: the microVM is the isolation
 * boundary, but a confused-deputy write outside the workspace root is
 * rejected with `SandboxEscapeError`. Remote host mounts have no referent in
 * a microVM, so there is no mount allow-set to consult here.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile as fsReadFile,
  rename,
  unlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { applyEdits } from "@agentick/sandbox";
import type { SandboxEdit, SandboxEditResult } from "@agentick/sandbox";
import { SandboxEscapeError, SandboxIoError } from "@agentick/sandbox";

/**
 * Resolve + validate a path within the workspace. String-based confinement
 * only (no symlink resolution) — the microVM is the real jail; this guards
 * against traversal out of the workspace root.
 */
export function resolveWorkspacePath(inputPath: string, workspacePath: string): string {
  if (inputPath.includes("\0")) {
    throw new SandboxEscapeError({
      kind: "path-traversal",
      target: inputPath,
      detail: "null byte",
    });
  }
  const absolute = isAbsolute(inputPath) ? inputPath : join(workspacePath, inputPath);
  const resolved = normalize(absolute);
  if (resolved === workspacePath || resolved.startsWith(workspacePath + "/")) {
    return resolved;
  }
  throw new SandboxEscapeError({
    kind: "path-traversal",
    target: inputPath,
    detail: `resolves to ${resolved}, outside workspace`,
  });
}

export async function agentReadFile(path: string, workspacePath: string): Promise<string> {
  const resolved = resolveWorkspacePath(path, workspacePath);
  try {
    return await fsReadFile(resolved, "utf-8");
  } catch (cause) {
    throw new SandboxIoError({ path, op: "read", reason: "read failed", cause });
  }
}

export async function agentWriteFile(
  path: string,
  content: string,
  workspacePath: string,
): Promise<void> {
  const resolved = resolveWorkspacePath(path, workspacePath);
  await mkdir(dirname(resolved), { recursive: true });
  await atomicWrite(path, resolved, content);
}

export async function agentEditFile(
  path: string,
  edits: readonly SandboxEdit[],
  workspacePath: string,
): Promise<SandboxEditResult> {
  const resolved = resolveWorkspacePath(path, workspacePath);
  let source: string;
  try {
    source = await fsReadFile(resolved, "utf-8");
  } catch (cause) {
    throw new SandboxIoError({ path, op: "edit", reason: "read for edit failed", cause });
  }
  // Pure, shared transform (crown jewel). The agent owns the atomic write.
  const result = applyEdits(source, edits);
  if (result.applied > 0) await atomicWrite(path, resolved, result.content);
  return result;
}

/**
 * Atomic write — temp file in the same dir + rename. Falls back to a direct
 * write for NFS/FUSE I/O errors where temp+rename can fail (mirrors
 * `LocalSandbox.atomicWrite` — the file-wrapper the ADR says the provider,
 * here the agent, owns).
 */
async function atomicWrite(path: string, resolved: string, content: string): Promise<void> {
  const tmp = join(dirname(resolved), `.write-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsWriteFile(tmp, content, "utf-8");
    await rename(tmp, resolved);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EIO" || code === "ENOENT" || code === "EXDEV") {
      try {
        await fsWriteFile(resolved, content, "utf-8");
        return;
      } catch (cause) {
        throw new SandboxIoError({ path, op: "write", reason: "write failed", cause });
      }
    }
    throw new SandboxIoError({ path, op: "write", reason: "atomic write failed", cause: err });
  }
}
