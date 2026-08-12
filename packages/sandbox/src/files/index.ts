/**
 * `@agentick/sandbox/files` — expose a sandbox (or a plain rooted
 * directory) as `file://` resources on a resources harness (ADR 65, the
 * read/projection half). No MCP dependency: these are resource resolvers,
 * composed over primitives that already exist.
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */

export {
  sandboxFileResolver,
  fsFileResolver,
  registerFileResolver,
  FILE_URI_TEMPLATE,
} from "./file-resolver.js";
export { pathToFileUri, fileUriFromPath, guessMimeType, isTextMime } from "./uri.js";
