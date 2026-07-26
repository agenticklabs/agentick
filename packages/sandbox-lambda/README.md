# @agentick/sandbox-lambda

The **prod remote sandbox provider**, backed by **AWS Lambda MicroVMs** —
long-lived, individually-addressable Firecracker microVMs with a full OS, a
dedicated HTTPS endpoint, native WebSocket/SSE/gRPC, and (as a fast-follow)
`suspend`/`resume` checkpointing. Local and docker providers are dev/staging;
**this is the production runtime** (ADR 60).

It implements `@agentick/sandbox`'s `SandboxProvider` — one microVM per
sandbox, an **in-VM sandbox-agent** (baked into the image) serving the contract
ops over an HTTP+WebSocket endpoint, `exec` streamed frame-by-frame with **no
exec ceiling**, atomic `editFile` via the base's shared `applyEdits` run IN-VM,
and **domain-level egress** via an in-VM proxy. Deps ONLY the base package
(mirroring `model-openai-next → model-next`) + AWS SDK v3 + a WS client.

## Architecture — the seam split

```
 ┌── provider (server-side) ──────────────┐        ┌── microVM (far side) ────────┐
 │ lambdaProvider(config)                 │        │  in-VM sandbox-agent          │
 │   → controlPlane.runMicrovm            │        │   HTTP:  /info /readFile      │
 │   → waitRunning (poll RUNNING)         │  wire  │         /writeFile /editFile  │
 │   → createAuthToken (JWE, server-only) │◀──────▶│   WS:    /exec (bash -c)      │
 │   → EndpointClient → /info             │ endpoint│   proxy: domain egress rules │
 │   → LambdaSandbox (SandboxHandle stub) │        │   fs:    the workspace        │
 └────────────────────────────────────────┘        └──────────────────────────────┘
                        ▲
        control plane = an INJECTABLE seam
   (AWS SDK v3 in prod; a loopback fake in tests)
```

The **control plane** (`run/get/create-auth-token/terminate-microvm`) is the
only piece that needs AWS. It is an injectable interface, so the entire
data-plane surface — agent, endpoint client, exec/fs/proxy — is **real-testable
over a loopback wire** (see [Verified by](#verified-by)).

## Quick start

### Minimal (production)

```ts
import { lambdaProvider } from "@agentick/sandbox-lambda";

const provider = lambdaProvider({
  imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/agentick-agent",
  aws: { region: "us-east-1" },
});

const sandbox = await provider.create({ workspace: true });
const { stdout } = await sandbox.exec("node -e 'console.log(1+1)'"); // "2"
await sandbox.destroy(); // terminate-microvm
```

### With network policy

```ts
const provider = lambdaProvider({
  imageIdentifier,
  aws: { region: "us-east-1" },
  internetEgressConnector: "arn:aws:lambda:us-east-1:123:network-connector/internet",
  vpcEgressConnector: "arn:aws:lambda:us-east-1:123:network-connector/vpc",
});

// Coarse public egress (INTERNET_EGRESS connector).
await provider.create({ allow: { network: true } });

// Domain-level rules — enforced by the IN-VM egress proxy (see below).
await provider.create({
  allow: { network: [{ action: "allow", domain: "*.github.com" }] },
});
```

### Advanced — inject a control plane (tests / custom credentials)

```ts
import { lambdaProvider } from "@agentick/sandbox-lambda";
import { fakeLambdaMicrovmsControlPlane } from "@agentick/sandbox-lambda/testing";

// A working loopback control plane: a real in-VM agent per microVM, no AWS.
const controlPlane = fakeLambdaMicrovmsControlPlane();
const provider = lambdaProvider({ imageIdentifier: "loopback", controlPlane });
```

## API

| Export                                          | Kind  | Purpose                                                        |
| ----------------------------------------------- | ----- | -------------------------------------------------------------- |
| `lambdaProvider(config)`                        | fn    | The `SandboxProvider`.                                         |
| `LambdaProviderConfig`                          | type  | Image ARN, control plane, connectors, idle policy, agent port. |
| `LambdaSandbox`                                 | class | The `SandboxHandle` client stub (one microVM).                 |
| `EndpointClient`                                | class | Near-side HTTP+WS client to the in-VM agent.                   |
| `awsLambdaMicrovmsControlPlane(config)`         | fn    | The AWS SDK v3 control plane.                                  |
| `LambdaMicrovmsControlPlane`                    | type  | The injectable control-plane seam.                             |
| `startSandboxAgent(opts)` (`/agent`)            | fn    | The in-VM server (baked into the image).                       |
| `AgentEgressProxy` (`/agent`)                   | class | The in-VM domain-egress proxy.                                 |
| `fakeLambdaMicrovmsControlPlane()` (`/testing`) | fn    | Loopback control plane (Meszaros fake).                        |

Subpaths: `.` (provider), `./agent` (in-VM bundle), `./testing` (doubles).
Bin: `agentick-sandbox-agent` (the image `CMD`).

## Capability tiers (honest — never fake)

| Capability                            | Lambda tier                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `exec` (streaming, no ceiling)        | ✅ WebSocket frames → `onOutput` + terminal exit frame                                                             |
| `readFile` / `writeFile` / `editFile` | ✅ HTTP; `editFile` runs `applyEdits` IN-VM, atomic write-back                                                     |
| `network: true`                       | ✅ attaches the `internetEgressConnector` ARN (public) when configured                                             |
| `network: false` / undefined          | ⚠️ attaches **no** egress connector — _intended_ deny-all, **not yet verified** on a real microVM (see known gaps) |
| `network: NetworkRule[]`              | ✅ **in-VM egress proxy** (domain rules) + optional `vpcEgressConnector` — **richer than docker**                  |
| runtime host mounts (`addMount` …)    | ❌ `SandboxUnsupportedError` — a host path has no referent in a remote microVM                                     |
| hibernate / `restore`                 | ⏳ fast-follow (#223) — native `suspend`/`resume`                                                                  |

**Divergence from docker (intentional):** `sandbox-docker-next` throws
`SandboxUnsupportedError` for a `NetworkRule[]` because `NetworkMode` cannot
express per-domain rules. Lambda **can** — the in-VM proxy runs the base's
shared `matchRequest` and injects `HTTP(S)_PROXY` into every exec env. Lambda's
VPC egress connectors govern only IP/port/CIDR, so per-domain enforcement lives
in-VM, exactly as the local provider does it.

## Building the microVM image

`sandbox-lambda-next` ships the **in-VM agent bundle + a documented Dockerfile
scaffold ONLY** (ADR 60, Ryan's ruling). The adopter runs `create-microvm-image`
(→ S3 → poll `CREATED`) as their own DevOps; the resulting image ARN becomes
`LambdaProviderConfig.imageIdentifier`. See [`Dockerfile`](./Dockerfile) — it
`FROM`s a Node base, bundles the agent, `EXPOSE 8080`, and `CMD`s the agent so
`create-microvm-image` snapshots it started-and-ready (no cold boot on run).

Per-session config (`env`, network rules) is delivered via the `run-microvm`
`runHookPayload`; the agent bin reads workspace/port/rules from the environment
(`SANDBOX_WORKSPACE` / `SANDBOX_AGENT_PORT` / `SANDBOX_NET_RULES`). Wiring the
`/run` lifecycle hook to translate the payload into that env is the image's
responsibility (documented integration point).

## Security invariants (ADR 60)

- **Credentials never cross the wire.** The provider's AWS creds
  (`lambda-microvms:*`, S3, ENI) are server-side only (instance profile / IRSA /
  task role — never static keys). The JWE microVM token is minted server-side by
  `create-microvm-auth-token`, held by the (server-side) `EndpointClient`, and
  **never projected to the client**.
- **IAM / IMDS (highest severity — NOT yet a hard lock).** There is no
  dedicated IMDS (`169.254.169.254`) block in the code. IMDS is reached only
  when the in-VM egress proxy is engaged (i.e. a `NetworkRule[]` was supplied)
  AND then only by its **default-deny** of unlisted hosts — and even that is a
  **soft** boundary: the proxy is enforced via `HTTP(S)_PROXY` env injection, so
  a process that ignores those vars bypasses it (see the `TODO(#226)` in
  `provider.ts`). A coarse-`network` sandbox (no rule list) starts **no** proxy
  at all. A hard IMDS lock — plus confirming whether Lambda injects a per-microVM
  runtime role — is an open pre-ship item (see known gaps).

## Status

**Wave: ADR 60 core contract.** Provider (`create`/`exec`/`readFile`/
`writeFile`/`editFile`/`destroy`) + coarse network switch + in-VM egress proxy
for domain rules + mounts capability-tier. AWS SDK client
(`@aws-sdk/client-lambda-microvms@^3.1080.0`) is a dependency and wired into
`awsLambdaMicrovmsControlPlane`.

### Roadmap & known gaps

- **Hibernate/restore (#223)** — `provider.restore`, `suspend`/`resume`,
  retain-on-`destroy`, `SandboxSnapshot = { microvmId }`. A tight fast-follow;
  Lambda MicroVMs is the first provider with a real checkpoint.
  `// TODO(#223)` trailheads mark the seams in `provider.ts` + `lambda-sandbox.ts`.
- **EFS / S3-prefix mounts** — a provider-extension reinterpretation of
  `addMount` (host binds stay unsupported). `// TODO(#226-followup)`.
- **`ProxiedRequest` → harness stream** — the in-VM proxy logs an audit trail +
  fires an `onProxiedRequest` callback; streaming it to the `sandbox:command`
  bridge is a follow-on.
- **Image-build helper CLI** — out of scope (adopter DevOps); may follow if it
  earns its keep.
- **`network: false` deny-all — UNVERIFIED (security-critical).** `resolveNetwork`
  attaches no egress connector for `false`/undefined, on the assumption that
  omission = deny-all. AWS networking docs suggest microVMs may have public
  egress BY DEFAULT; if so, `network: false` silently grants full internet.
  Needs confirmation on a real microVM, and likely an explicit deny/no-egress
  connector. `// TODO(#226)` in `provider.ts`.
- **Hard IMDS lock + per-microVM runtime role** — the current IMDS story is a
  soft, proxy-only, default-deny (above). A dedicated hard block and
  confirmation of Lambda's runtime-role injection are pre-ship items.
- **Large-file `readFile`** — `agentReadFile` buffers the whole file into the
  response body with **no** size backstop (the 64 MB `MAX_BODY_BYTES` limit
  gates only inbound `writeFile`/`editFile` REQUEST bodies, not read responses).
  SSE/WS streaming for very large reads is a follow-on.

## Verified by

- `src/__tests__/loopback-conformance.spec.ts` — the shared #218
  `runSandboxProviderConformance` suite against a **real** in-VM agent over a
  loopback wire (real HTTP/WS, real fs, real bash). Exercises
  exec-stream/readFile/writeFile/editFile/mounts-tier/destroy.
- `src/__tests__/control-plane.spec.ts` — provider `create()` orchestration
  order (`runMicrovm → waitRunning → createAuthToken → handle → terminate`) via
  a spy over the loopback fake; create-time env delivery; **plus** the
  AWS-integration conformance run, gated on real AWS (`SANDBOX_LAMBDA_TEST_IMAGE`
  - region), registered skipped where AWS is absent.
- `src/__tests__/egress-proxy.spec.ts` — the in-VM proxy forwards an allowed
  host (200) and denies an unlisted host (403, default-deny) against a real
  origin.
