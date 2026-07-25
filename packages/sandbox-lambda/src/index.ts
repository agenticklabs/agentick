/**
 * `@agentick/sandbox-lambda` — the AWS Lambda MicroVMs
 * {@link SandboxProvider} (ADR 60). The PROD remote sandbox runtime.
 *
 * One Firecracker microVM per sandbox, an in-VM sandbox-agent (baked into the
 * image, shipped from the `./agent` subpath) serving the contract over an
 * HTTP+WebSocket endpoint. Handle ops are requests to that agent: fs over
 * HTTP, exec streamed over WS (no exec ceiling), atomic `editFile` via the
 * base's shared `applyEdits` run IN-VM. Deps ONLY the base package
 * `@agentick/sandbox` (+ AWS SDK v3 + a WS client) — mirroring
 * `model-openai-next → model-next`.
 *
 * Capability tier (honest, per ADR 60 — never fake): runtime host mounts throw
 * `SandboxUnsupportedError` (no shared host); DOMAIN-level network rules ARE
 * supported (in-VM egress proxy), unlike docker's coarse `NetworkMode`.
 *
 * The control plane is an injectable seam — production wires
 * {@link awsLambdaMicrovmsControlPlane} (AWS SDK v3); the loopback conformance
 * suite wires a stub + a real agent. Hibernate/restore (#223) is a fast-follow.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

export { lambdaProvider, type LambdaProviderConfig } from "./provider.js";
export { LambdaSandbox, type LambdaSandboxInit } from "./lambda-sandbox.js";
export { EndpointClient, type EndpointClientConfig } from "./endpoint-client.js";

export {
  awsLambdaMicrovmsControlPlane,
  type AwsControlPlaneConfig,
  type CreateAuthTokenOptions,
  type LambdaMicrovmsControlPlane,
  type MicrovmIdlePolicy,
  type RunMicrovmOptions,
  type RunMicrovmResult,
  type WaitRunningOptions,
} from "./control-plane.js";

export {
  AGENT_DEFAULT_PORT,
  decodeRunHookPayload,
  encodeRunHookPayload,
  type RunHookPayload,
  type SerializedSandboxError,
} from "./protocol.js";
