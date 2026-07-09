# ADR 72 — Native UI seam: `ui://` IR resources → MCP-Apps / AG-UI projections → inbox-relay interaction

**Status:** DRAFT 2026-07-09 (Fable, for Ryan — design workshop). **Revisits** ADR 40's "defer
first-class MCP-Apps" stance. **Builds on:** ADR 62 (resources — `ui://` rides the general seam;
`@agentick/mcp-apps-next` reserved for rendering), Flow E (`15-flows/e-resource-render-no-loop` —
the reconciler renders JSX → a resource body with NO loop, browser-safe), ADR 69 (request
escalation + the addressable session inbox), ADR 71 (the `--framework` reconciler binding + the
`clients/` axis), ADR 23/26/27 (everything is a projection of a native seam).

## TL;DR

Agentick renders UI through **one native seam**: a **`ui://` resource whose content is agentick
IR** — authored in JSX (the same reconciler that builds model context, Flow E), rendered
**client-side** by the `--framework` binding, kept live by the resource `subscribe`/`notifyUpdated`
fan. **MCP-Apps and AG-UI are down-projections of that one seam** (client + server sides), exactly
as tools/tasks/elicitation project to the MCP wire. **Interactive UI → tool calls route through the
addressable session inbox via the ADR 69 relay** — no new bridge; the escalation substrate
generalized. Nothing new at the substrate: resources + reconciler IR + the ADR 69 relay, composed.

## The native seam — `ui://` carries IR, not opaque HTML

A `ui://` resource is an ordinary `ResourcesHarness` registration (ADR 62 — schemes, `read(uri)`,
templated URIs, `subscribe`). Its **content is agentick IR** (a `RenderedTree` fragment), produced
by the reconciler's Level-1/2 render (Flow E), NOT a raw HTML string:

- **Authoring** — the agent writes UI in JSX, the same components + reconciler as context; a
  `ui://` mount renders to an IR fragment (Flow E, no loop).
- **Client render** — the `--framework` binding (`reconciler-react-next` today; Angular/Solid
  siblings) renders the IR fragment in the browser. `@agentick/react` is already browser-safe
  (Flow E). So the binding is **dual-purpose**: model-context IR *and* client-UI IR.
- **Live** — `subscribe("ui://…")` + `notifyUpdated` gives reactive UI for free (ADR 62 fan).

Why IR, not HTML: IR keeps the framework binding + reactivity + type-safety, and — critically —
**insulates us from the MCP-Apps spec churn ADR 40 flagged.** We own the native IR; HTML is one
*down-projection* we emit when a wire demands it. The spec can move; our seam doesn't.

## Projections — one seam, N wire forms (client + server)

| Consumer | Projection | Where |
| --- | --- | --- |
| **Agentick client** (native) | `read ui://` → IR → render with the framework binding | client-next + the binding |
| **MCP-Apps** | IR **→ HTML**, exposed as an `MCPApp`/`ui://` app resource | `@agentick/mcp-apps-next` (the package ADR 62 reserved) on the MCP **server** harness |
| **AG-UI** | IR / UI-state **→ AG-UI events** | `@agentick/ag-ui-next` on the **gateway** |

Each projection is an *encoding* of the native IR-over-`ui://` seam — the same pattern that makes a
tool/task/elicitation a native harness with an MCP-wire codec on top. This is what lets us **honor
MCP-Apps and AG-UI without either owning the model**: an adopter targeting an MCP client gets the
HTML projection; one targeting an AG-UI client gets the event projection; the agentick client gets
the native IR. One authoring surface.

## Interaction — the ADR 69 relay, generalized

A `ui://` UI is interactive: MCP-Apps can call tools of their serving MCP server; a native UI can
call the agent's tools. That is a **request originating at a leaf (the UI, in the client) that must
reach its origin's tools** — precisely ADR 69's shape:

- The `ui://` resource carries its **origin** (which session / which MCP server owns it).
- A UI tool-call is a message **addressed through the session inbox** (`session:${id}`) →
  - **native** origin → the session's `dispatch` (agentick tools);
  - **mcp-app** origin → relayed on via `bridges.mcp.client(serverId)` → the external MCP server.
- The response threads back down the relay — the same nested-`ask` return path ADR 69 uses.

So the chain `agentick-client → session → mcp-client → mcp-server` is bridged by the **addressable
inbox we already built**. We do NOT invent a UI-interaction transport; the escalation relay IS it.
(Ancestor interception + lineage from ADR 69 T2a even apply — an agent can mediate what a rendered
sub-UI is allowed to call.)

## Trust boundary — at the projection, not the seam

- **Native IR** is *trusted* — agent-authored, type-checked, rendered by our binding.
- **MCP-App HTML** (inbound from a 3rd-party server, or our outbound projection consumed by a 3rd
  party) is *untrusted* — rendered in a **sandboxed iframe**, tool-calls gated through the inbox
  relay (where interception can deny). The trust flip lives at the HTML projection, not in the
  native seam — keeping the core clean.

## Why revisit ADR 40's "defer"

ADR 40 deferred first-class MCP-Apps on spec-instability grounds. Three things changed: **(1)**
resources landed (#123), so `ui://` has a home; **(2)** the ADR 69 escalation relay exists, so the
interaction bridge is free; **(3)** AG-UI arrived as a second driver, so a *unifying* seam (not an
MCP-Apps-specific one) is now the right investment. Owning the native IR seam + projecting is
*more* spec-stable than tracking MCP-Apps directly — the exact concern ADR 40 raised, inverted.

## Rejected
- **`ui://` content = raw HTML.** Opaque, spec-coupled, loses the framework binding + reactivity +
  type-safety. HTML is a down-projection, not the seam.
- **A bespoke UI subsystem.** It's resources (ADR 62) + reconciler IR (Flow E) + the ADR 69 relay,
  composed. No new substrate.
- **A separate UI-interaction transport.** The addressable inbox relay already spans
  `client → session → mcp-client → mcp-server`.
- **MCP-Apps or AG-UI as the model.** Either as the native model couples us to one wire spec; both
  become projections of the agentick IR seam instead.

## Open (workshop)
1. **IR vs a narrower UI-component-descriptor** as `ui://` content — full `RenderedTree`, or a
   UI-scoped subset? (Model context IR carries things a UI doesn't need.)
2. **One renderer or two** — is the client-UI renderer the *same* reconciler binding as
   agent-authoring, or a UI-specific renderer over the shared IR?
3. **Tool-call origin-addressing** — the exact inbox address scheme for native-dispatch vs
   mcp-app-relay origins, and how the `ui://` resource carries origin.
4. **AG-UI fidelity** — how much of AG-UI's event vocabulary the gateway projection covers; is it
   lossy?
5. **Package split** — `@agentick/mcp-apps-next` (server HTML projection + inbound app render) and
   `@agentick/ag-ui-next` (gateway event projection) as separate optional packages; the native
   render lives in client-next + the binding.
6. **Security model** for untrusted inbound MCP-App HTML (sandbox policy, capability gating via the
   relay).

@see the workshop artifact (native-ui-seam) for the rendered diagram + resolved-decision log.
