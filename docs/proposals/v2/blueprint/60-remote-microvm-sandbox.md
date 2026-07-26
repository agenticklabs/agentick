# ADR 60 — `sandbox-lambda-next`: the prod remote sandbox provider (AWS Lambda MicroVMs)

**Status:** PROPOSED 2026-07-07, **CORRECTED 2026-07-07** (Fable, for Ryan) after reading the
actual [Lambda MicroVMs guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html).
**The original A-vs-C substrate fork is WITHDRAWN — it was reasoned from _classic_ Lambda and
is obsolete.** **Depends on:** ADR 59 (the sandbox contract + base). **Prod-critical** (this is
the prod runtime; local/docker are dev/staging). **Build gated only on Ryan's go — the design
below is stable against the real offering.**

## TL;DR (what the research changed)

AWS **Lambda MicroVMs** is a _new, purpose-built_ offering — AWS's own framing is "sandboxes for
AI… multiple users or AI agents connect to a compute environment and run code." It is **not**
classic Lambda. It is a **long-lived, individually-addressable Firecracker microVM** with a full
OS, a dedicated HTTPS endpoint, and native **`suspend`/`resume`** that preserves memory + disk.
This **collapses the survey's Fork 1**: there is no bounded "invoke-per-op, 900s, no persistent
processes" substrate. Lambda MicroVMs delivers the _persistent, long-running, addressable_
characteristics the survey attributed only to a self-operated Firecracker fleet — **serverless,
with a real checkpoint.** So: **`sandbox-lambda-next` first** (prod runtime), and a self-operated
`sandbox-firecracker-next` becomes a _later portability/control_ play (non-AWS, cost-at-scale),
**not a capability fork.**

## What Lambda MicroVMs actually is (grounded in the guide)

| Concern                   | Reality                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation                 | Firecracker microVM (KVM) — the microVM _is_ the jail; strongest tier                                                                                                      |
| OS                        | **Full OS** — install system packages, mount filesystems                                                                                                                   |
| Addressing                | **Dedicated HTTPS endpoint per microVM**: `<microvmId>.lambda-microvm.<region>.on.aws`                                                                                     |
| Protocols on the endpoint | HTTP/1.1, **HTTP/2, WebSockets, gRPC, SSE**                                                                                                                                |
| Persistent processes      | **Survive** — it's a running VM, not an invocation. Dev servers/watchers work                                                                                              |
| Exec ceiling              | **None.** (The `900` in AWS examples is the _idle-suspend_ timer, not an exec wall)                                                                                        |
| Checkpoint (#223)         | **`suspend-microvm`/`resume-microvm` preserve memory + disk state** — real                                                                                                 |
| Idle cost                 | idle-policy: `{maxIdleDurationSeconds, suspendedDurationSeconds, autoResumeEnabled}` — suspend when idle, auto-resume on inbound traffic (`502` if resume exceeds retries) |
| Sizes                     | baseline 0.5 GB/0.25 vCPU → 8 GB/4 vCPU (+ vertical scale); endpoint bandwidth **1→16 MB/s** scales with size                                                              |

### The control surface (`aws lambda-microvms` → AWS SDK v3 client)

1. **Build (deploy-time, once per image version):** `create-microvm-image`
   `--name --code-artifact uri=s3://… --base-image-arn <lambda-managed-OS> --build-role-arn …`.
   Lambda runs the Dockerfile, **starts the app, and snapshots the fully-initialized state**
   (Firecracker snapshot ⇒ no boot delay on run). Poll `get-microvm-image` → `CREATED`.
2. **Run (per session):** `run-microvm`
   `--image-identifier --ingress-network-connectors <ARN> --egress-network-connectors <ARN>
--idle-policy '{…}'` → `{microvmId, state:PENDING, endpoint}`. Poll `get-microvm` → `RUNNING`.
3. **Connect:** `create-microvm-auth-token`
   `--microvm-identifier --expiration-in-minutes N --allowed-ports '[{port:8080}]'|[{allPorts:{}}]'`
   → **JWE `authToken`**. Every request carries `X-aws-proxy-auth: <token>`; target port via
   `X-aws-proxy-port: <N>` header (or WS subprotocol `lambda-microvms.port.N`), default 8080.
   Wrong/absent token or unlisted port → **403**. `X-aws-proxy-*` headers are stripped before
   your app sees the request.
4. **Hibernate:** `suspend-microvm` / `resume-microvm` (or automatic via idle-policy).
5. **Teardown:** `terminate-microvm`.

### The in-VM server is OURS

AWS provides no in-guest agent. **You run your own server in the image** (Dockerfile `CMD`,
listening on a port; 8080 is the default route target). This is the far-side "**sandbox-agent**"
the `*-remote-next` convention anticipates — we bake it into the image, and it serves the
contract ops over the endpoint.

## Design — `sandbox-lambda-next` on the ADR-59 contract

Two build artifacts, one package:

### 1. The provider (server-side, `SandboxProvider`)

- `create(opts)` → `run-microvm` (from a configured image ARN) → poll `RUNNING` →
  `create-microvm-auth-token` → returns a `SandboxHandle` wrapping
  **`{ endpoint, microvmId, token, port }` + an HTTPS/WS client** (the handle is a _client stub_,
  not the workspace — exactly what ADR 59's async handle contract allows; confirmed the contract
  holds for a remote provider).
- **Handle ops → requests to the in-VM sandbox-agent** over the endpoint (with the JWE header):
  - `readFile` / `writeFile` / `editFile` → HTTP(S) POST routes on the agent. **`editFile` runs
    `applyEdits` IN-VM** (one round-trip, atomic temp+rename on the workspace fs — not a
    server-side read→edit→write two-hop).
  - `exec` → **WebSocket (or HTTP/2 / SSE) stream** to the agent → stdout/stderr frames map to the
    `onOutput` seam (harness bridges to `sandbox:command:exec` `delta`, #219). Terminal frame
    carries `{exitCode, signaled, durationMs}`. Native WS/gRPC/SSE support makes streaming
    first-class. **No exec ceiling** — long builds/tests finish; the open connection carries them.
- **Token lifecycle is server-side.** The provider mints + refreshes JWE tokens
  (`create-microvm-auth-token`) as they near expiry. **The token never crosses the wire to the
  client** — it is a server-side capability to reach the microVM; the client sees only the
  harness/bridge status + verbs (per credentials-never-cross-wire).
- `destroy(opts)` → `terminate-microvm` (default) — see hibernate for the retain path.

### 2. The in-VM sandbox-agent (baked into the microVM image)

- A small HTTP/WS server (Dockerfile `CMD`, port 8080) that serves the contract ops against the
  local workspace fs: `applyEdits` (shared from `sandbox-next`), an exec runner (spawns `bash -c`,
  streams frames), and the **in-VM egress proxy** (below).
- Shipped as a second bundle in the package; the adopter's image Dockerfile `FROM`s a workspace
  base and adds this agent. `create-microvm-image` snapshots it started-and-ready.

### 3. Networking — in-VM proxy for domain rules; connectors for the coarse switch

The guide **confirms** the survey's read: egress is either default public internet or a
customer **VPC egress connector**, and VPC egress is governed by **security groups + NACLs
(IP/port/CIDR) — no per-domain rules, no per-request URL logging** (VPC flow logs are too coarse
for `ProxiedRequest`). Therefore:

- **Domain-level `NetworkRule[]` enforcement = the same in-VM egress proxy** used by local/docker,
  running the base's shared `matchRequest`/`matchDomain` (zero new shared code — already in
  `sandbox-next`). Inject `HTTP(S)_PROXY` into the in-VM exec env; emit `ProxiedRequest` from in-VM.
- The **coarse outer switch** (`network: true/false`) maps to the egress connector ARN:
  `INTERNET_EGRESS` (public) vs a VPC connector vs none.

### 4. Hibernate/restore (#223) — NATIVE, and Lambda is the first provider that can honestly do it

`suspend-microvm`/`resume-microvm` preserve **memory + disk** state. So:

- `SandboxSnapshot` for lambda = **`{ microvmId }`** — the _suspended microVM itself is the
  snapshot_ (no serialization of workspace state needed; disk + memory are intact on resume).
- restore = `resume-microvm` (or the idle-policy auto-resumes on the next inbound request).
- `destroy()` gets a **retain-vs-terminate** choice: terminate (ephemeral, default) or
  suspend-and-retain (restore-capable, storage/idle cost). **This retires the #223 deferral
  rationale** ("no provider has a real checkpoint") — Lambda MicroVMs has one. Wire #223 here.

### 5. Mounts

Full OS + can mount filesystems (EFS via a VPC connector, or the microVM disk). A host-path
`SandboxMount` still has **no referent** in a remote microVM → `addMount`/`removeMount`/`listMounts`
throw `SandboxUnsupportedError` (honest capability-tier), **or** are reinterpreted as
"attach EFS access point / S3 prefix" via a provider extension. **Never fake a host mount.**
`mountAllow` still gates. Note disk persists across suspend/resume, so the workspace fs is
naturally durable within a microVM's life.

## ⚠️ IAM / IMDS invariant (INVARIANT — highest severity)

The microVM has a **full OS and a reachable metadata surface**; if AWS injects any ambient
execution role, the sandboxed `bash` can lift it (IMDS `169.254.169.254` / env). That is an escape
into the AWS account with **no local/docker analog**. Non-negotiable:

1. **Verify** whether Lambda MicroVMs injects a per-microVM runtime role at all. The guide shows
   only a **build role** (assumed by the Lambda service during `create-microvm-image`) and a
   **network-connector operator role** (assumed by Lambda to create ENIs) — _no per-microVM
   in-VM execution role is documented_. Confirm on a real microVM before shipping; the ambient
   surface may be smaller than a classic-Lambda mental model assumes.
2. **Regardless: the in-VM proxy/env blocks IMDS** (`169.254.169.254`) so the shell can't lift any
   host credentials, and any in-VM role (if present) grants **only** the workspace fs.
3. The **provider's** AWS creds (`lambda-microvms:*`, S3 for artifacts, ENI for VPC connectors) are
   **server-side only** (instance profile / IRSA / task role — never static keys, never cross the
   wire). The JWE microVM token is likewise server-side only.

## Decisions

- **RESOLVED (Ryan, 2026-07-07) — image build ownership:** `sandbox-lambda-next` ships the
  **in-VM agent bundle + a documented Dockerfile scaffold ONLY**. The adopter runs
  `create-microvm-image` (→ S3 → poll) as their own DevOps/CI. No build-helper CLI in v1 — it can
  follow if it earns its keep. The microVM **image ARN is provider config**.
- **RESOLVED (Ryan, 2026-07-07) — #223 hibernate is a FAST-FOLLOW.** First delegation lands the
  **core contract** (create/exec-stream/readFile/writeFile/editFile/net-proxy/destroy) +
  conformance against a real microVM. A tight second delegation adds hibernate
  (`suspend`/`resume`, retain-on-`destroy`, `SandboxSnapshot = {microvmId}`, `resume` on restore).

### Remaining decisions (small; none gate the shape)

1. **Ephemeral vs retained default** on `destroy()` — terminate (cheap) vs suspend-retain
   (restore-capable). Config knob; default terminate. (Settled in the hibernate fast-follow.)
2. **`SandboxCreateOptions.setup`** — bake into the image (rebuild) vs a post-`run` `exec` on
   first create. Lean: image for static setup, `exec` for per-session.
3. **`readFile` large-file protocol** — endpoint bandwidth is 1–16 MB/s by size; stream large
   reads over the open connection (SSE/WS) rather than a single buffered body; hard ceiling+error
   only as a backstop.
4. **Cold vs warm posture** — snapshot-start is fast (no boot), but `run-microvm`→`RUNNING` has a
   provisioning tail; a small warm pool vs on-demand-per-session is a cost/latency knob.
5. **Idle-policy defaults** — `maxIdleDurationSeconds` / `suspendedDurationSeconds` /
   `autoResumeEnabled` tuned for agent sessions (suspend on idle, auto-resume on next tool call).

## Package shape

`@agentick/sandbox-lambda`, deps `@agentick/sandbox` **only** + AWS SDK v3
(`@aws-sdk/client-lambda-microvms` or the shipped client) + a minimal HTTP/WS client. Passes
`runSandboxProviderConformance` against a **real** microVM (no fakes — the stat/readdir lesson).
**Do NOT extract shared "remote provider" primitives yet** — `applyEdits` + the matcher are already
in the base; what's left (endpoint client, JWE token manager, exec frame codec, suspend/resume
restore) is Lambda-specific with ONE consumer. Three-consumers rule: leave a `// TODO` trailhead;
extract when `sandbox-firecracker-next` / E2B arrives.

## The "both" (Firecracker fleet) — now a later, orthogonal play

Ryan wants both Lambda and a self-operated Firecracker fleet. With the real offering, the fleet is
**not a capability fork** (Lambda MicroVMs already gives persistence + long execs + suspend/resume).
`sandbox-firecracker-next` (Fargate/EC2-metal, self-operated) earns its place only for
**portability/control/cost-at-scale/non-AWS** reasons, and it reuses the _same in-VM sandbox-agent
bundle_ (the agent is substrate-independent; only the provider's lifecycle/control differs). Ship
Lambda first; the fleet is a follow-on that inherits this design's far-side.

## Scope

Design corrected to the real offering. Build gated on Ryan's go. The contract (ADR 59) holds for a
remote provider; the design's load-bearing invariant is the IAM/IMDS lock.
