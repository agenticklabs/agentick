---
"@agentick/transport": minor
"@agentick/transport-http": minor
"@agentick/transport-websocket": minor
"@agentick/transport-unix-socket": minor
"@agentick/transport-in-process": minor
---

Importing a client transport into a browser bundle no longer drags the
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
