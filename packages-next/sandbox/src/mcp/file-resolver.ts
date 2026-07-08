/**
 * Mount/file → readable-resource projection (ADR 65 / ADR 62).
 *
 * A `TemplateResolver` for `file://{+path}` that reads a file's content
 * and returns it as {@link ResourceContents}, so a boundary declared as a
 * root (outbound) is also READABLE as a resource (server → client, ADR 62).
 * Two backends:
 *
 *   - {@link sandboxFileResolver} — reads THROUGH the sandbox's read-file
 *     command (ACL-gated, provider-backed). The sandbox handle exposes
 *     only text reads (ADR 59: `bash` subsumes binary), so content comes
 *     back as UTF-8 text; a binary path degrades to best-effort text with
 *     the guessed mime, never a fabricated blob.
 *   - {@link fsFileResolver} — the no-sandbox path: plain Node fs, rooted
 *     at a directory (containment-checked). Reads binary losslessly as a
 *     base64 blob when the mime is non-text.
 *
 * Register either on a {@link Resources} harness via
 * {@link registerFileResolver} (or `resources.registerTemplate` directly).
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
  ResourceContents,
  Resources,
  ResourceTemplateMeta,
  TemplateResolver,
} from "@agentick/spec-next";
import type { Unsubscribe } from "@agentick/runtime-next";

import type { SandboxHarness } from "../harness.js";
import { fileUriFromPath, guessMimeType, isTextMime } from "./uri.js";

/**
 * The canonical template a file-resolver registers under. `{+path}` is a
 * reserved expansion (crosses `/`), so a full `file:///abs/path` matches.
 */
export const FILE_URI_TEMPLATE = "file://{+path}";

/**
 * A `TemplateResolver` that reads files through a sandbox. The concrete
 * matched uri (`file:///abs/path`) is decoded to a path and read via the
 * sandbox's `read-file` command, so the read is ACL-gated + provider-backed.
 *
 * Text-only by the handle contract (ADR 59): content returns as
 * {@link TextResourceContents} with the extension-guessed mime. A binary
 * file is best-effort UTF-8 text — sane, not corrupt-blob.
 *
 * TODO(#237-4b / ADR-65): a lossless binary read needs a `readFileBytes`
 * on the sandbox handle contract. Until then the sandbox path is text; the
 * fs path ({@link fsFileResolver}) is the lossless-binary backend.
 */
export function sandboxFileResolver(sandbox: SandboxHarness): TemplateResolver {
  return async (uri: string): Promise<readonly ResourceContents[]> => {
    const path = fileUriFromPath(uri);
    const text = await sandbox.readFile({ path });
    return [{ uri, mimeType: guessMimeType(path), text }];
  };
}

/**
 * A `TemplateResolver` that reads files off the local filesystem — the
 * no-sandbox read path. Rooted at `rootDir`: a decoded path that escapes
 * the root (via `..` or an absolute elsewhere) is rejected, so a
 * `file://` template can't be walked outside its declared boundary.
 *
 * Text mimes read as UTF-8 {@link TextResourceContents}; everything else
 * reads losslessly as a base64 {@link BlobResourceContents}.
 */
export function fsFileResolver(rootDir: string): TemplateResolver {
  const root = resolve(rootDir);
  return async (uri: string): Promise<readonly ResourceContents[]> => {
    const requested = fileUriFromPath(uri);
    const abs = resolve(requested);
    // Containment: the resolved path must be the root itself or nested
    // beneath it. `sep`-suffix guards against a sibling prefix match
    // (`/data-other` vs `/data`).
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`fsFileResolver: path escapes root: ${requested}`);
    }
    const mimeType = guessMimeType(abs);
    if (isTextMime(mimeType)) {
      const text = await readFile(abs, "utf8");
      return [{ uri, mimeType, text }];
    }
    const buffer = await readFile(abs);
    return [{ uri, mimeType, blob: buffer.toString("base64") }];
  };
}

/**
 * Register a file-resolver on a {@link Resources} harness under the
 * `file://{+path}` template, so files become readable resources. Returns
 * the `Unsubscribe` from `registerTemplate`.
 */
export function registerFileResolver(
  resources: Resources,
  resolver: TemplateResolver,
  meta?: ResourceTemplateMeta,
): Unsubscribe {
  return resources.registerTemplate(
    FILE_URI_TEMPLATE,
    resolver,
    meta ?? { name: "file", description: "Read a file by its file:// URI" },
  );
}
