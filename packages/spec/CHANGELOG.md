# @agentick/spec

## 1.0.0-next.6

## 1.0.0-next.5

## 1.0.0-next.4

### Minor Changes

- The session-principal completion (ADR 48): principal stamped at
  creation (host door + wire door from the authenticated identity;
  params cannot set it), inherited by spawn/fork children, fork inherits
  the metadata bag, onSessionCreate gains a reshape arm, and
  SessionInstaller exposes principal + metadata at install. The
  same-principal wire target rule now engages on the stamped value.
  SessionRecord gains principal (durable stores should round-trip it).
  Plus MCP: RFC-9728 protected-resource metadata endpoint and the HTTP
  auth pre-gate (401 + WWW-Authenticate before SDK handling).

## 1.0.0-next.3

### Patch Changes

- Per-request ingress identity now reaches wire hook/middleware ctx
  (ctx.identity: IngressIdentity, riding EventScope like origin) and
  WireExtensionContext.identity carries the structured object beside the
  principal string — enabling adopter-space principal-override hooks on
  session-creating wire methods.

## 1.0.0-next.2

### Patch Changes

- Shared-server citizenship for the HTTP and WebSocket server transports:
  attached ({ httpServer }) transports now ignore non-matching requests
  and upgrades instead of 404ing/destroying them, so they coexist with
  the adopter's routes and other websocket consumers (e.g. socket.io) on
  one Node server. Owned ({ port }) behavior unchanged.
