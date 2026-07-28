# @agentick/transport-http

## 1.0.0-next.21

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.21
  - @agentick/transport@1.0.0-next.21

## 1.0.0-next.20

### Minor Changes

- Importing a client transport into a browser bundle no longer drags the
  server transport in with it. It used to fail the build outright:

      ERROR in node:crypto
      Module build failed: UnhandledSchemeError: Reading from "node:crypto"
      is not handled by plugins

  The chain was `@agentick/transport-websocket/client` → the ROOT
  `@agentick/transport` barrel → `export * from "./server/index.js"` →
  `web-security.ts` → `node:crypto`. All three client transports imported
  that root barrel, so every browser bundle carried the whole server half —
  until it hit a `node:` specifier and stopped.

  Two causes, each fixed where it lived rather than at the import site.

  `CSRF_HEADER` was declared in `server/web-security.ts`, but a header name
  is a WIRE fact: the client has to send what the server checks. It now
  lives in `src/shared/wire.ts` and is exported from both doors, so the HTTP
  client has no reason to reach into `server/` at all.

  The root barrel re-exported the client surface, which is precisely what
  made `from "@agentick/transport"` look like the right import for client
  code. It is now the Node door only — server dispatch, ingress
  authentication, web security, shared wire facts. Client code imports
  `@agentick/transport/client`, which is browser-safe by contract.

  BREAKING for anyone importing `BaseClientTransport`, `MultiplexedStream`,
  `transportError`, `DEFAULT_RECONNECT_POLICY`, or `computeFullJitterBackoff`
  from `@agentick/transport` — they are behind `@agentick/transport/client`.
  That is only relevant if you are writing a transport.

  A workspace sweep now walks the real module graph out of every browser entry
  point — each `./client` subpath, each `@agentick/client*` root, each `browser`
  condition — and fails on any reachable `node:` builtin, naming the full import
  chain so the offending edge is obvious. It reproduces the original failure
  exactly when the bad edge is put back.

  `@agentick/transport-unix-socket` now DENIES the `browser` export condition on
  every subpath. Its `/client` is the connecting end of a same-host IPC pair, not
  a browser client, and `node:net` there is correct. Declaring it means a web
  bundler that lands on the package fails with "not exported under browser
  condition" instead of an unresolvable scheme, and the sweep above needs no
  exception list.

  For adopters, `@agentick/transport-http` and `@agentick/transport-websocket`
  gain a `browser` export condition on their root: the same specifier
  resolves to the client barrel in a browser bundle. The dual root stays for
  a process that owns both halves, but a browser asking for it now gets
  something that builds, and asking it for `websocketServer` is a
  named-export error that says what is wrong instead of an unresolvable
  `node:` scheme.

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.20
  - @agentick/transport@1.0.0-next.20

## 1.0.0-next.19

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.19
  - @agentick/transport@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.18
  - @agentick/transport@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.17
  - @agentick/transport@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.16
  - @agentick/transport@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.15
  - @agentick/transport@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.14
  - @agentick/transport@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.13
  - @agentick/transport@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.12
  - @agentick/transport@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.11
  - @agentick/transport@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.10
  - @agentick/transport@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.9
  - @agentick/transport@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.8
  - @agentick/transport@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.7
  - @agentick/transport@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.6
  - @agentick/transport@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.5
  - @agentick/transport@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.4
  - @agentick/transport@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.3
  - @agentick/transport@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.2
  - @agentick/transport@1.0.0-next.2
