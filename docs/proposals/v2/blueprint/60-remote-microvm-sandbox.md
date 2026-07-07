# ADR 60 — Remote microVM sandbox provider (prod): the substrate fork + the common design

**Status:** PROPOSED 2026-07-07 (Fable, for Ryan). **Fork 1 (the substrate) is OPEN — Ryan's
call; it gates the build.** Everything substrate-independent below is stable.
**Depends on:** ADR 59 (the sandbox contract + base). **Prod-critical** (this is the prod
runtime; local/docker are dev/staging).

## TL;DR

The v2 sandbox contract (ADR 59) **holds for a remote, ephemeral provider** — the survey
verified conformance only requires *filesystem* persistence across `exec`s, not *process*
persistence (local's `exec` already spawns fresh `bash -c` each call). So a remote provider
whose handle is a **client stub** (AWS SDK client + workspace identity, not the workspace
itself) is contract-conformant. But **which remote substrate** — AWS Lambda (serverless,
bounded) vs a Firecracker microVM fleet (Fargate/EC2-metal, persistent) — is a product
decision with severe consequences, and the package name should follow the intent.

## Fork 1 — THE substrate (OPEN, gates everything)

Deciding question: **does the prod agent runtime need persistent processes (dev
servers/watchers), >15-min execs (big builds/tests), or interactive long-lived sessions?**

| | **A. AWS Lambda + EFS** (invoke-per-op) | **C. Firecracker fleet** (Fargate/EC2-metal) |
|---|---|---|
| 900s/exec ceiling | hard wall (a >15-min build can't finish) | none (you own VM lifetime) |
| Persistent processes / bg dev servers | **die between invokes — unsupported** | persist |
| Per-op latency | warm ~tens-ms; cold 0.2–several s | one boot (~30–60s), then in-mem |
| Restore (#223) | **nearly free** (snapshot = EFS access-point id + intent; re-mount) | needs real VM snapshot/recreate — wires #223 |
| Cost | scale-to-zero, cheap | you run the fleet |
| Isolation | Firecracker (KVM microVM) | Firecracker (KVM microVM) |
| Name | `sandbox-lambda-next` | `sandbox-firecracker-next` / `-fargate-next` |

- **A** is right if each agent action is a **bounded short exec** with no long-lived servers.
  Ships cleanly + cheaply + **without #223** (Lambda(A) is exactly the remote provider the
  #223 deferral anticipated). But dev-servers/watchers and >15-min builds are out.
- **C** is what "prod agent runtime" usually implies (a coding agent runs long builds, dev
  servers, interactive sessions). Costs a fleet + cold start + real snapshot for restore.
- **Tiered** (both) only if prod genuinely has both workload shapes.

**Fable's lean:** a coding agent (ernesto-shaped) likely needs long builds + dev servers →
**C**, and "Lambda microVMs" probably meant "Firecracker microVMs" loosely (Lambda runs on
Firecracker; so does Fargate). But this is Ryan's product call — if prod actions are bounded,
A is materially cheaper/simpler. **Reconcile the package name to the ruling.**

## Substrate-INDEPENDENT design (common to A and C — stable, spec now)

- **Remote provider = client stub.** The `SandboxHandle` a remote provider returns holds a
  client + workspace identity, not the workspace. `SandboxProvider`/`SandboxHandle` unchanged
  (ADR 59, in `sandbox-next`); deps `@agentick/sandbox-next` only (the corrected grain).
- **Two build targets** (new vs local/docker): (1) the **provider** (agentick server, AWS
  SDK v3 client); (2) the **in-VM "sandbox-agent"** bundle running *inside* the microVM
  (`applyEdits` + exec runner + the in-VM egress proxy). This is the server/far-side split
  the `*-remote-next` convention anticipates.
- **Control channel + streaming (#219):** each handle op → one call into the sandbox-agent
  with `{op, args, workspaceRef}`. `exec` streams stdout/stderr frames back
  (`InvokeWithResponseStream` for Lambda; chunked/gRPC for a fleet) → the provider parses to
  the `onOutput` seam, which the harness already bridges to `sandbox:command:exec` `delta`.
  Terminal frame carries `{exitCode, signaled, durationMs}`.
- **`applyEdits` runs IN-VM** (bundled into the sandbox-agent) — one round-trip, atomic
  temp+rename local to the workspace fs. (Not a server-side read→edit→write two-hop.)
- **Workspace = persistent fs** (EFS access point for A; the VM's disk for C) — and *is* the
  restore token. `/tmp` is scratch only.
- **Network — in-VM proxy, not VPC/SG.** VPC/SG/NAT are coarse (IP/port/CIDR, can't do
  domain rules); VPC flow logs are too coarse for `ProxiedRequest` (no URL/method/domain).
  So run the **same in-VM egress proxy** using the base's shared matcher, inject
  `HTTP(S)_PROXY` into the in-VM exec env, emit `ProxiedRequest` from in-VM. Zero new shared
  code (matcher already in `sandbox-next`). Coarse VPC/SG is the outer `network:true/false`.
- **Mounts:** host-path `SandboxMount` has no referent in a microVM → `addMount`/`removeMount`/
  `listMounts` throw `SandboxUnsupportedError` (honest capability-tier), OR are reinterpreted
  as "attach EFS access point / S3 prefix" via a provider extension. **Never fake a host mount.**
  `mountAllow` still gates.

## ⚠️ IAM invariant (INVARIANT — highest severity, both substrates)

The **in-VM execution role is an ambient AWS credential the sandboxed `bash` can reach**
(IMDS `169.254.169.254` / env vars). A permissive role means the agent escapes into your AWS
account — a class of exposure with **no local/docker analog**. Non-negotiable:
1. The in-VM role grants **only** the workspace fs (the EFS access point) — nothing else.
2. The in-VM proxy/env **blocks IMDS** (`169.254.169.254`) so the shell can't lift the role's
   credentials.
3. The **provider's** AWS creds (invoke + EFS + ENI) are server-side only (instance
   profile / IRSA / task role — never static keys, never cross the wire; the client sees
   only the harness/bridge status+verbs). Per credentials-never-cross-wire.

## Remaining forks (mostly resolved; some ride on Fork 1)
2. **Restore default** — `destroy()` deletes the workspace (cheap, ephemeral) vs retains it
   (restore-capable, storage cost). A ⇒ optionally wire #223 now (nearly free); C ⇒ needs
   real snapshot. Ryan's call on ephemeral-vs-persistent default.
3. **`applyEdits` location** — RESOLVED: in-VM (single call, atomic).
4. **`SandboxMount` semantics** — `SandboxUnsupportedError` vs EFS/S3-attach reinterpret.
5. **Cold-start posture** — provisioned/warm (pay idle) vs on-demand (first tool call eats
   cold start). Latency-vs-cost; likely a config knob.
6. **`readFile` large-file protocol** — hard ceiling+error vs response-streaming vs
   S3-presigned. (A has a 6/20MB cap; C is unbounded.)

## Package shape
`@agentick/sandbox-<substrate>-next` (name per Fork 1), deps `@agentick/sandbox-next` only +
AWS SDK v3. **Do NOT extract shared "remote provider" primitives yet** — the reusable pieces
(`applyEdits`, matcher) are already in the base; what's left (remote-envelope codec, stream
framing, restore-from-intent) is substrate-specific with ONE consumer. Three-consumers rule:
leave a `// TODO` trailhead; extract when a second remote provider (E2B, etc.) arrives.

## Scope
Design captured. **Build is gated on Fork 1** (Ryan). The substrate-independent design +
the IAM invariant are stable and hold under either ruling.
