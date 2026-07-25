/**
 * The Lambda MicroVMs control-plane seam (ADR 60).
 *
 * The load-bearing split: the in-VM agent + endpoint client are FULLY
 * real-testable over a loopback wire (real HTTP/WS, real fs, real bash); only
 * the AWS control plane — `run-microvm` / `get-microvm` /
 * `create-microvm-auth-token` / `terminate-microvm` — is untestable without a
 * real account, so it is a thin INJECTABLE interface. The provider orchestrates
 * against {@link LambdaMicrovmsControlPlane}; production wires
 * {@link awsLambdaMicrovmsControlPlane} (AWS SDK v3), tests wire a stub +
 * a loopback agent.
 *
 * ## IAM / IMDS invariant (highest severity — ADR 60)
 * The provider's AWS credentials (`lambda-microvms:*`, S3 for artifacts, ENI
 * for VPC connectors) are SERVER-SIDE ONLY (instance profile / IRSA / task
 * role — never static keys, never across the wire). The JWE microVM token is
 * likewise server-side only. The in-VM proxy blocks IMDS (`169.254.169.254`)
 * so the sandboxed shell cannot lift any ambient role.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  type PortSpecification,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { AUTH_TOKEN_MAP_KEY } from "./protocol.js";

// ── The seam interface ───────────────────────────────────────────────────────

/** Idle-policy (auto-suspend / auto-resume) for a run. */
export interface MicrovmIdlePolicy {
  readonly maxIdleDurationSeconds: number;
  readonly suspendedDurationSeconds: number;
  readonly autoResumeEnabled: boolean;
}

export interface RunMicrovmOptions {
  /** The microVM image ARN/id to run (provider config). */
  readonly imageIdentifier: string;
  /** Optional image version. */
  readonly imageVersion?: string;
  /** Ingress connector ARNs (how clients reach the endpoint). */
  readonly ingressNetworkConnectors?: readonly string[];
  /** Egress connector ARNs (the COARSE network switch: INTERNET_EGRESS / VPC / none). */
  readonly egressNetworkConnectors?: readonly string[];
  /** Idle-policy — suspend on idle, auto-resume on inbound traffic. */
  readonly idlePolicy?: MicrovmIdlePolicy;
  /** Max microVM lifetime in seconds (platform ceiling, 1–28800). */
  readonly maximumDurationInSeconds?: number;
  /**
   * Per-microVM init payload delivered to the `/run` lifecycle hook. We use it
   * to pass per-session config (workspace, network rules) the agent reads.
   */
  readonly runHookPayload?: string;
}

export interface RunMicrovmResult {
  readonly microvmId: string;
  readonly endpoint: string;
}

export interface CreateAuthTokenOptions {
  readonly expiryMinutes: number;
  /** Ports the token grants access to. `undefined` → default agent port (8080). */
  readonly allowedPorts?: readonly number[];
}

export interface WaitRunningOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * The control-plane ops the provider needs. Production impl wraps AWS SDK v3;
 * a stub + loopback agent tests the provider's create() orchestration.
 */
export interface LambdaMicrovmsControlPlane {
  runMicrovm(options: RunMicrovmOptions): Promise<RunMicrovmResult>;
  waitRunning(microvmId: string, options?: WaitRunningOptions): Promise<void>;
  /**
   * Mint a JWE endpoint token. Returns `{ token: null }` when no auth is
   * required (loopback / direct dev) — a `null` token signals the endpoint
   * client to omit `X-aws-proxy-*` headers.
   */
  createAuthToken(
    microvmId: string,
    options: CreateAuthTokenOptions,
  ): Promise<{ token: string | null }>;
  terminateMicrovm(microvmId: string): Promise<void>;
}

// ── Concrete AWS SDK v3 impl ─────────────────────────────────────────────────

export interface AwsControlPlaneConfig {
  /** AWS region. Falls back to the SDK's default resolution when omitted. */
  readonly region?: string;
  /**
   * Inject a pre-configured client (credentials from an instance profile /
   * IRSA — NEVER static keys). Overrides `region`. Useful for tests + custom
   * credential providers.
   */
  readonly client?: LambdaMicrovmsClient;
  /** Poll interval for `waitRunning`. Default 1500ms. */
  readonly pollIntervalMs?: number;
  /** Poll timeout for `waitRunning`. Default 120000ms. */
  readonly pollTimeoutMs?: number;
}

/**
 * Create a control plane backed by AWS Lambda MicroVMs (AWS SDK v3). All AWS
 * credentials are resolved server-side by the SDK's default chain (instance
 * profile / IRSA / task role) — the provider never handles static keys.
 */
export function awsLambdaMicrovmsControlPlane(
  config?: AwsControlPlaneConfig,
): LambdaMicrovmsControlPlane {
  const client =
    config?.client ?? new LambdaMicrovmsClient(config?.region ? { region: config.region } : {});
  const defaultInterval = config?.pollIntervalMs ?? 1500;
  const defaultTimeout = config?.pollTimeoutMs ?? 120_000;

  return {
    async runMicrovm(options) {
      const res = await client.send(
        new RunMicrovmCommand({
          imageIdentifier: options.imageIdentifier,
          ...(options.imageVersion !== undefined ? { imageVersion: options.imageVersion } : {}),
          ...(options.ingressNetworkConnectors
            ? { ingressNetworkConnectors: [...options.ingressNetworkConnectors] }
            : {}),
          ...(options.egressNetworkConnectors
            ? { egressNetworkConnectors: [...options.egressNetworkConnectors] }
            : {}),
          ...(options.idlePolicy ? { idlePolicy: { ...options.idlePolicy } } : {}),
          ...(options.maximumDurationInSeconds !== undefined
            ? { maximumDurationInSeconds: options.maximumDurationInSeconds }
            : {}),
          ...(options.runHookPayload !== undefined
            ? { runHookPayload: options.runHookPayload }
            : {}),
        }),
      );
      if (!res.microvmId || !res.endpoint) {
        throw new Error("run-microvm returned no microvmId/endpoint");
      }
      return { microvmId: res.microvmId, endpoint: res.endpoint };
    },

    async waitRunning(microvmId, options) {
      const interval = options?.intervalMs ?? defaultInterval;
      const timeout = options?.timeoutMs ?? defaultTimeout;
      const deadline = Date.now() + timeout;
      for (;;) {
        const res = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
        if (res.state === "RUNNING") return;
        if (res.state === "TERMINATED" || res.state === "TERMINATING") {
          throw new Error(`microVM ${microvmId} entered ${res.state} before RUNNING`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `microVM ${microvmId} not RUNNING within ${timeout}ms (state=${res.state})`,
          );
        }
        await sleep(interval);
      }
    },

    async createAuthToken(microvmId, options) {
      const allowedPorts: PortSpecification[] = (options.allowedPorts ?? [8080]).map((port) => ({
        port,
      })) as PortSpecification[];
      const res = await client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes: options.expiryMinutes,
          allowedPorts,
        }),
      );
      const token = res.authToken?.[AUTH_TOKEN_MAP_KEY] ?? null;
      return { token };
    },

    async terminateMicrovm(microvmId) {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
