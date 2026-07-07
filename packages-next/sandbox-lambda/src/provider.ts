/**
 * `lambdaProvider` — a {@link SandboxProvider} backed by AWS Lambda MicroVMs
 * (ADR 60). The PROD remote runtime (local/docker are dev/staging).
 *
 * `create()` orchestrates the control plane, then hands off to the in-VM
 * agent:
 *   1. resolve the network tier (coarse egress connector + domain rule list);
 *   2. `run-microvm` (from the configured image ARN, with the per-session
 *      config as `runHookPayload`) → `{ microvmId, endpoint }`;
 *   3. `waitRunning` (poll `get-microvm` → `RUNNING`);
 *   4. `create-microvm-auth-token` → the JWE token (server-side only);
 *   5. construct an {@link EndpointClient}, probe `/info` for the workspace
 *      root, and return a {@link LambdaSandbox}.
 *
 * ## Network tier — richer than docker (flagged: intentional divergence)
 * Unlike `sandbox-docker-next` (which throws `SandboxUnsupportedError` for a
 * `NetworkRule[]` because `NetworkMode` can't express per-domain rules),
 * Lambda MicroVMs CAN do domain rules — via the IN-VM egress proxy. So:
 *   - `network === true`  → the `INTERNET_EGRESS` egress connector (public).
 *   - `false` / undefined → no egress connector (deny-all).
 *   - `NetworkRule[]`     → the domain rules flow to the in-VM proxy (via the
 *     `runHookPayload`); the coarse VPC egress connector (if configured) is
 *     attached for the outer allow. NOT an error.
 *
 * `restore` is intentionally absent — the hibernate fast-follow (#223) adds
 * `suspend`/`resume`, `SandboxSnapshot = { microvmId }`, and the
 * retain-on-`destroy` choice. Lambda MicroVMs is the first provider that can
 * honestly checkpoint (native `suspend`/`resume` preserve memory + disk).
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import type {
  NetworkRule,
  SandboxCreateOptions,
  SandboxHandle,
  SandboxPermissions,
  SandboxProvider,
} from "@agentick/sandbox-next";
import {
  type AwsControlPlaneConfig,
  awsLambdaMicrovmsControlPlane,
  type LambdaMicrovmsControlPlane,
  type MicrovmIdlePolicy,
} from "./control-plane.js";
import { EndpointClient } from "./endpoint-client.js";
import { LambdaSandbox } from "./lambda-sandbox.js";
import { AGENT_DEFAULT_PORT, encodeRunHookPayload, type RunHookPayload } from "./protocol.js";

export interface LambdaProviderConfig {
  /** MicroVM image ARN/id to run (built by the adopter's `create-microvm-image`). */
  readonly imageIdentifier: string;
  /** Optional image version. */
  readonly imageVersion?: string;
  /**
   * The control plane. Injectable so tests wire a stub + loopback agent.
   * Defaults to {@link awsLambdaMicrovmsControlPlane} using `aws` config.
   */
  readonly controlPlane?: LambdaMicrovmsControlPlane;
  /** AWS SDK config for the DEFAULT control plane (ignored if `controlPlane` is injected). */
  readonly aws?: AwsControlPlaneConfig;
  /** Ingress connector ARNs (how clients reach the endpoint). */
  readonly ingressNetworkConnectors?: readonly string[];
  /** Egress connector ARN for `network === true` (public internet). */
  readonly internetEgressConnector?: string;
  /** Egress connector ARN attached alongside a `NetworkRule[]` (VPC coarse allow). */
  readonly vpcEgressConnector?: string;
  /** Idle-policy (auto-suspend / auto-resume) tuned for agent sessions. */
  readonly idlePolicy?: MicrovmIdlePolicy;
  /** Max microVM lifetime in seconds (platform ceiling). */
  readonly maximumDurationInSeconds?: number;
  /** JWE token expiry in minutes (max 60). Default 60. */
  readonly authExpiryMinutes?: number;
  /** In-VM agent port (the endpoint route target). Default 8080. */
  readonly agentPort?: number;
}

/**
 * Create a Lambda MicroVMs sandbox provider.
 *
 * @example
 * ```ts
 * import { lambdaProvider } from "@agentick/sandbox-lambda-next";
 *
 * const provider = lambdaProvider({
 *   imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/agentick-agent",
 *   aws: { region: "us-east-1" },
 *   internetEgressConnector: "arn:aws:lambda:us-east-1:123:network-connector/internet",
 * });
 * const sandbox = await provider.create({ workspace: true, allow: { network: true } });
 * const { stdout } = await sandbox.exec("node -e 'console.log(1+1)'"); // "2"
 * await sandbox.destroy(); // terminate-microvm
 * ```
 */
export function lambdaProvider(config: LambdaProviderConfig): SandboxProvider {
  const controlPlane = config.controlPlane ?? awsLambdaMicrovmsControlPlane(config.aws);
  const agentPort = config.agentPort ?? AGENT_DEFAULT_PORT;
  const authExpiryMinutes = config.authExpiryMinutes ?? 60;

  return {
    name: "lambda",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      const net = resolveNetwork(options.allow?.network, config);

      const runHook: RunHookPayload = {
        ...(net.networkRules ? { networkRules: net.networkRules } : {}),
        ...(options.env ? { baseEnv: options.env } : {}),
      };

      const run = await controlPlane.runMicrovm({
        imageIdentifier: config.imageIdentifier,
        ...(config.imageVersion !== undefined ? { imageVersion: config.imageVersion } : {}),
        ...(config.ingressNetworkConnectors
          ? { ingressNetworkConnectors: config.ingressNetworkConnectors }
          : {}),
        ...(net.egressConnectors ? { egressNetworkConnectors: net.egressConnectors } : {}),
        ...(config.idlePolicy ? { idlePolicy: config.idlePolicy } : {}),
        ...(config.maximumDurationInSeconds !== undefined
          ? { maximumDurationInSeconds: config.maximumDurationInSeconds }
          : {}),
        runHookPayload: encodeRunHookPayload(runHook),
      });

      await controlPlane.waitRunning(run.microvmId);

      const { token } = await controlPlane.createAuthToken(run.microvmId, {
        expiryMinutes: authExpiryMinutes,
        allowedPorts: [agentPort],
      });

      const client = new EndpointClient({ endpoint: run.endpoint, port: agentPort, token });

      // `/info` is the final readiness confirmation AND the workspace-root
      // source (a remote provider has no host workspace to allocate).
      const info = await client.info();

      return new LambdaSandbox({
        id: run.microvmId,
        workspacePath: info.workspacePath,
        client,
        onDestroy: () => controlPlane.terminateMicrovm(run.microvmId),
      });
      // TODO(#223): hibernate fast-follow — add `restore(snapshot)` here
      // (resume-microvm; SandboxSnapshot = { microvmId }) + a retain-on-destroy
      // config knob. Lambda MicroVMs has a real checkpoint (suspend/resume).
    },
  };
}

interface ResolvedNetwork {
  readonly egressConnectors?: readonly string[];
  readonly networkRules?: readonly NetworkRule[];
}

/**
 * Map the ADR 59 network policy onto Lambda's connectors + the in-VM proxy.
 * Unlike docker, a `NetworkRule[]` is SUPPORTED (domain enforcement in-VM).
 */
function resolveNetwork(
  network: SandboxPermissions["network"],
  config: LambdaProviderConfig,
): ResolvedNetwork {
  if (network === true) {
    return config.internetEgressConnector
      ? { egressConnectors: [config.internetEgressConnector] }
      : {};
  }
  if (network === undefined || network === false) {
    // No egress connector attached → intended deny-all egress.
    // TODO(#226): VERIFY on a real microVM — the AWS networking doc says
    // "MicroVMs have public internet access on the egress path" BY DEFAULT.
    // If omitting the connector yields default-PUBLIC egress (not deny-all),
    // `network:false` silently grants full internet to a sandbox that asked
    // for none — a security hole. The in-VM proxy is soft (HTTP_PROXY env; a
    // process ignoring it bypasses domain rules), so the connector is the HARD
    // boundary. If default-public is confirmed, deny-all needs an explicit
    // "no-egress"/deny connector here, NOT mere omission.
    return {};
  }
  // NetworkRule[] — domain rules flow to the in-VM proxy; the VPC egress
  // connector (if configured) is the coarse outer allow.
  return {
    networkRules: network,
    ...(config.vpcEgressConnector ? { egressConnectors: [config.vpcEgressConnector] } : {}),
  };
}
