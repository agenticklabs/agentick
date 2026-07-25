# syntax=docker/dockerfile:1
#
# Sandbox-agent microVM image scaffold (ADR 60).
#
# The adopter builds THIS into a Lambda MicroVM image with
# `create-microvm-image --base-image-arn <lambda-managed-OS> --code-artifact
# uri=s3://…`. Lambda runs the Dockerfile, STARTS the agent, and snapshots the
# fully-initialized state (Firecracker snapshot ⇒ no boot delay on run). The
# resulting image ARN becomes `LambdaProviderConfig.imageIdentifier`.
#
# This is a SCAFFOLD, not a turnkey image: pin your base image, add your
# toolchain (compilers, language runtimes, CLIs the agent will `exec`), and
# bundle the built agent. `@agentick/sandbox-lambda` ships the agent + this
# scaffold ONLY — image build is the adopter's DevOps (Ryan's ruling, ADR 60).
#
# @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md

# Use a base with Node 22+ and bash. In production this is layered on the
# Lambda-managed base image passed to `create-microvm-image`.
FROM node:22-slim

# Toolchain the sandboxed `bash` will need (extend as your workloads require).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The workspace root the agent serves (matches the agent's default).
ENV SANDBOX_WORKSPACE=/workspace
RUN mkdir -p /workspace
WORKDIR /workspace

# Bundle the built agent. Produce this artifact from the workspace:
#   pnpm --filter @agentick/sandbox-lambda build
# then COPY the compiled `dist/` (and its runtime deps) into the image. The
# exact copy layout depends on your bundler; a self-contained bundle (esbuild
# --bundle of src/agent/bin.ts) is the simplest to snapshot.
COPY dist/ /opt/sandbox-agent/dist/
COPY node_modules/ /opt/sandbox-agent/node_modules/

# The default Lambda MicroVMs route target port.
EXPOSE 8080
ENV SANDBOX_AGENT_PORT=8080
ENV SANDBOX_AGENT_HOST=0.0.0.0

# Start the agent. `create-microvm-image` snapshots it started-and-ready, so a
# run-microvm attaches to an already-listening agent with no cold boot.
CMD ["node", "/opt/sandbox-agent/dist/agent/bin.js"]
