/**
 * `@agentick/sandbox-docker` — the Docker {@link SandboxProvider}
 * (ADR 59, Wave 2b).
 *
 * One container per sandbox, commands via `docker exec` (streamed through
 * `onOutput`), file I/O via exec, atomic `editFile` via the base's shared
 * `applyEdits`, coarse egress via `NetworkMode`. Deps ONLY the base package
 * `@agentick/sandbox` and implements its `SandboxProvider` — mirroring
 * `@agentick/model-openai → @agentick/model`. The base re-exports the spec wire types,
 * the `applyEdits` transform, and the error classes, so this provider has
 * ONE import source.
 *
 * Capability tier (honest, per ADR 59 — never fake): runtime mounts
 * (`addMount`/`removeMount`/`listMounts`) and per-domain network rules throw
 * `SandboxUnsupportedError`. Create-time `mounts` (via `-v`) and the coarse
 * boolean network tier work.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export { dockerProvider, type DockerProviderConfig } from "./provider.js";
export { DockerSandbox, type DockerSandboxInit, type MountInfo } from "./docker-sandbox.js";
export { resolveContainerPath, shellQuote } from "./docker-sandbox.js";
export { DockerAPI, DockerAPIError } from "./docker-api.js";
export type {
  ContainerConfig,
  ExecConfig,
  ExecStreamCallbacks,
  ExecStreamResult,
} from "./docker-api.js";
