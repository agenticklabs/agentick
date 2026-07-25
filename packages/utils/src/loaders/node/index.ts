/**
 * `@agentick/utils/loaders/node` — filesystem-backed loaders.
 *
 * Separate subpath because importing `node:fs` from the main loaders
 * module would break browser / edge-runtime usage. Harness packages
 * that need filesystem sources import from here; record-typed
 * `fromFile` / `fromDirectory` factories live in those packages.
 */

export {
  sourceFromFile,
  readFrontmatterFile,
  type FileRecord,
  type FrontmatterFileRecord,
  type FromFileOptions,
} from "./from-file.js";
export { sourceFromDirectory, type FromDirectoryOptions } from "./from-directory.js";
