/**
 * @agentick/sandbox-docker — Docker sandbox provider
 *
 * Container-based process isolation via Docker Engine API over Unix socket.
 * Zero external dependencies. Same Sandbox contract as sandbox-local — swap one line.
 */

export { dockerProvider } from "./provider.js";
export type { DockerProviderConfig } from "./provider.js";
