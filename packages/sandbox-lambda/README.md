# @agentick/sandbox-lambda

**A `SandboxProvider` where the sandbox is somebody else's machine.** One Firecracker microVM per sandbox on AWS Lambda MicroVMs, each with a full OS, its own HTTPS endpoint, and an in-VM agent that serves the sandbox contract over HTTP and WebSocket. `exec` streams frame by frame with no execution ceiling, `editFile` runs the shared transform inside the VM, and egress is filtered per domain by a proxy that also lives in the VM.

The interesting consequence of a remote sandbox is that host paths stop meaning anything, so runtime mounts are unsupported and say so. The interesting compensation is that per-domain egress — which a container can't express — works here.

## Install

```bash
npm install @agentick/sandbox @agentick/sandbox-lambda
```

Subpaths: `.` (the provider, server-side), `./agent` (the in-VM bundle, baked into your image), `./testing` (a loopback control plane). Ships the `agentick-sandbox-agent` bin as the image's `CMD`.

## How the pieces sit

```
 ┌── your server ─────────────────────────┐          ┌── the microVM ───────────────┐
 │ lambdaProvider(config)                 │          │  in-VM sandbox agent          │
 │   runMicrovm                           │          │   HTTP  /info /readFile        │
 │   waitRunning        (poll RUNNING)    │  HTTPS   │         /writeFile /editFile   │
 │   createAuthToken    (JWE, never sent) │◀────────▶│   WS    /exec (bash -c)        │
 │   EndpointClient  →  /info             │ endpoint │   proxy domain egress rules    │
 │   LambdaSandbox   =  SandboxHandle     │          │   fs    the workspace          │
 └────────────────────────────────────────┘          └───────────────────────────────┘
                     ▲
     the control plane is an injectable seam
```

Only the control plane — `runMicrovm`, `waitRunning`, `createAuthToken`, `terminateMicrovm` — needs AWS. Because it's an interface you can swap, the whole data plane (agent, endpoint client, exec streaming, filesystem, proxy) is testable over a real loopback wire with no cloud account. That's how the conformance suite runs.

## Quick start

```ts
import { lambdaProvider } from "@agentick/sandbox-lambda";

const provider = lambdaProvider({
  imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/agentick-agent",
  aws: { region: "us-east-1" },
});

const sandbox = await provider.create({ workspace: true });
const { stdout } = await sandbox.exec("node -e 'console.log(1 + 1)'"); // "2\n"
await sandbox.destroy(); // terminateMicrovm
```

Under an agent you mount the provider with `<Sandbox provider={provider}>` and let the four built-in tools drive it — see [@agentick/sandbox](../sandbox).

## Network policy

Two tiers, and unlike a container the second one is real:

```ts
const provider = lambdaProvider({
  imageIdentifier,
  aws: { region: "us-east-1" },
  internetEgressConnector: "arn:aws:lambda:us-east-1:123:network-connector/internet",
  vpcEgressConnector: "arn:aws:lambda:us-east-1:123:network-connector/vpc",
});

// Coarse public egress — attaches the internet egress connector.
await provider.create({ allow: { network: true } });

// Domain rules — enforced by the in-VM proxy running the base's matchRequest.
await provider.create({
  allow: {
    network: [
      { action: "allow", domain: "*.github.com" },
      { action: "deny", domain: "*" },
    ],
  },
});
```

A rule list starts the in-VM egress proxy and injects `HTTP_PROXY` and `HTTPS_PROXY` into every `exec` environment. Lambda's own egress connectors govern IP, port, and CIDR only, so domain-level enforcement has to live inside the VM — the same place [@agentick/sandbox-local](../sandbox-local) puts it.

> [!WARNING]
> Proxy enforcement is soft. A process that ignores `HTTP(S)_PROXY` and opens a socket directly is not filtered. Domain rules shape well-behaved traffic; they are not a containment boundary.

## Testing without AWS

`fakeLambdaMicrovmsControlPlane()` is a working control plane that starts a **real** agent per microVM on loopback. Nothing is mocked below it — real HTTP, real WebSocket, real filesystem, real `bash`. Only the AWS calls are replaced:

```ts
import { lambdaProvider } from "@agentick/sandbox-lambda";
import { fakeLambdaMicrovmsControlPlane } from "@agentick/sandbox-lambda/testing";

const controlPlane = fakeLambdaMicrovmsControlPlane();
const provider = lambdaProvider({ imageIdentifier: "loopback", controlPlane });

const sandbox = await provider.create({ workspace: true });
// ... the full create/exec/fs/destroy path, over a real wire
await sandbox.destroy();
```

That's also the seam for custom credential resolution: implement `LambdaMicrovmsControlPlane` yourself and pass it as `controlPlane`, and the `aws` config is ignored.

## Capability tiers

| Capability                                | On Lambda MicroVMs                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `exec`                                    | Supported. WebSocket frames reach `onOutput`, then a terminal exit frame. No ceiling. |
| `readFile` / `writeFile` / `editFile`     | Supported over HTTP. `editFile` runs `applyEdits` in-VM with an atomic write-back.    |
| `network: true`                           | Supported — attaches `internetEgressConnector` when configured.                       |
| `network: false` / omitted                | Attaches no egress connector. Intended as deny-all but **unverified** (see gaps).     |
| `network: NetworkRule[]`                  | Supported by the in-VM proxy, plus `vpcEgressConnector` when configured.              |
| `addMount` / `removeMount` / `listMounts` | Throws `SandboxUnsupportedError` — a host path has no referent in a remote microVM.   |
| `restore` / hibernate                     | Not implemented. The platform has native suspend and resume; the seam isn't wired.    |

## Building the microVM image

This package ships the in-VM agent bundle and a documented [`Dockerfile`](./Dockerfile) scaffold. Building the image is yours: run `create-microvm-image` against your artifact, and the resulting ARN becomes `imageIdentifier`.

The scaffold layers on a Node base, bundles the agent, exposes port 8080, and sets the agent as `CMD` so `create-microvm-image` snapshots it already started — which is what removes cold boot from `create()`. Pin your own base image and add whatever toolchain your workloads will `exec`.

Per-sandbox configuration travels in the `run-microvm` hook payload. The agent bin reads its workspace, port, and network rules from the environment (`SANDBOX_WORKSPACE`, `SANDBOX_AGENT_PORT`, `SANDBOX_NET_RULES`), and translating the hook payload into that environment is the image's `/run` lifecycle hook — a documented integration point, not something this package can do for you.

## Security posture

**Credentials never cross the wire.** AWS credentials stay server-side and should come from an instance profile, IRSA, or a task role — never static keys. The JWE endpoint token is minted server-side by `createAuthToken`, held by the server-side `EndpointClient`, and never projected to a client.

> [!CAUTION]
> **There is no hard IMDS block, and this is the highest-severity open item.** Nothing in the code denies `169.254.169.254` outright. It's unreachable only when a rule list engaged the in-VM proxy, and then only via the proxy's default-deny — which the warning above already tells you is bypassable. A sandbox created with coarse `network: true` starts no proxy at all. Do not run untrusted code against a microVM whose runtime role you haven't audited.

## API

### `@agentick/sandbox-lambda`

| Export                                                                                                           | Purpose                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lambdaProvider(config)`                                                                                         | The provider.                                                                                                                                                                                                      |
| `LambdaProviderConfig`                                                                                           | `imageIdentifier`, `imageVersion`, `controlPlane`, `aws`, `ingressNetworkConnectors`, `internetEgressConnector`, `vpcEgressConnector`, `idlePolicy`, `maximumDurationInSeconds`, `authExpiryMinutes`, `agentPort`. |
| `LambdaSandbox` / `LambdaSandboxInit`                                                                            | The handle: a client stub over one microVM.                                                                                                                                                                        |
| `EndpointClient` / `EndpointClientConfig`                                                                        | Server-side HTTP and WebSocket client to the in-VM agent.                                                                                                                                                          |
| `awsLambdaMicrovmsControlPlane(config?)`                                                                         | The AWS SDK v3 control plane, and the default when you pass `aws`.                                                                                                                                                 |
| `LambdaMicrovmsControlPlane`                                                                                     | The injectable seam: `runMicrovm`, `waitRunning`, `createAuthToken`, `terminateMicrovm`.                                                                                                                           |
| `AwsControlPlaneConfig`                                                                                          | `region`, `client`, `pollIntervalMs`, `pollTimeoutMs`.                                                                                                                                                             |
| `MicrovmIdlePolicy` / `RunMicrovmOptions` / `RunMicrovmResult` / `WaitRunningOptions` / `CreateAuthTokenOptions` | Control-plane call shapes.                                                                                                                                                                                         |
| `encodeRunHookPayload` / `decodeRunHookPayload` / `RunHookPayload`                                               | Per-sandbox config delivery to the image.                                                                                                                                                                          |
| `AGENT_DEFAULT_PORT` / `SerializedSandboxError`                                                                  | Port default (8080) and the wire error shape.                                                                                                                                                                      |

### `@agentick/sandbox-lambda/agent`

Runs **inside** the VM. The provider never imports it.

| Export                                                                        | Purpose                               |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| `startSandboxAgent(options)` / `SandboxAgent`                                 | The far-side server.                  |
| `AgentEgressProxy` / `EgressProxyConfig`                                      | The in-VM domain-egress proxy.        |
| `runExec` / `ExecController` / `ExecRunOptions` / `ExecRunResult`             | The exec primitive behind `WS /exec`. |
| `agentReadFile` / `agentWriteFile` / `agentEditFile` / `resolveWorkspacePath` | The filesystem primitives.            |

### `@agentick/sandbox-lambda/testing`

| Export                                         | Purpose                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| `fakeLambdaMicrovmsControlPlane(options?)`     | Loopback control plane starting a real agent per microVM. |
| `FakeControlPlane` / `FakeControlPlaneOptions` | Its type and configuration.                               |

## Patterns

**Under an agent.** [@agentick/sandbox](../sandbox) wraps the handle with journaling, the approval gate, and the four model-facing tools.

**Choosing a provider.** [@agentick/sandbox-local](../sandbox-local) for development on the host with OS jails; [@agentick/sandbox-docker](../sandbox-docker) for container reproducibility; this one when the sandbox must not share a machine with your server.

**Certifying your own.** `runSandboxProviderConformance` from `@agentick/sandbox/testing` is what pins this provider over the loopback wire.

## Roadmap & known gaps

- **`network: false` deny-all is unverified, and it's security-critical.** The provider attaches no egress connector for `false` or omitted, assuming omission means deny-all. AWS networking documentation suggests microVMs may have public egress by default — if so, `network: false` silently grants full internet. Confirm on a real microVM before trusting it, and expect this to need an explicit no-egress connector.
- **No hard IMDS lock.** See the security note above. A dedicated block, plus confirmation of how Lambda injects a per-microVM runtime role, are pre-ship items.
- **Hibernate and restore aren't wired.** The platform has native `suspend` and `resume`, which would make this the first provider with a real checkpoint, but `provider.restore`, retain-on-destroy, and the snapshot shape are unimplemented.
- **No EFS or S3-prefix mounts.** Reinterpreting `addMount` for remote storage is the obvious extension; host binds stay unsupported regardless.
- **Proxy audit trail doesn't reach the harness.** The in-VM proxy keeps a log and fires `onProxiedRequest`, but streaming those records onto the sandbox event surface is unbuilt.
- **`readFile` has no size backstop.** It buffers the whole file into the response body. The 64 MB inbound body limit gates `writeFile` and `editFile` requests only, not read responses, so a very large read can exhaust memory. Streaming reads are a follow-on.
- **No image-build helper.** Image construction is deliberately left to adopter DevOps; only the agent bundle and the Dockerfile scaffold ship here.

## Verified by

- `src/__tests__/loopback-conformance.spec.ts` — `runSandboxProviderConformance` against a real in-VM agent over a loopback wire: real HTTP and WebSocket, real filesystem, real `bash`. Covers exec streaming, `readFile`, `writeFile`, `editFile`, the mounts capability tier, and destroy.
- `src/__tests__/control-plane.spec.ts` — `create()` orchestration order (`runMicrovm` → `waitRunning` → `createAuthToken` → handle → `terminateMicrovm`) observed through a spy over the loopback fake, and create-time environment delivery. Also runs the conformance suite against real AWS when `SANDBOX_LAMBDA_TEST_IMAGE` and a region are set, registering as skipped otherwise.
- `src/__tests__/egress-proxy.spec.ts` — the in-VM proxy forwards an allowed host and returns 403 for an unlisted one, against a real origin server.
