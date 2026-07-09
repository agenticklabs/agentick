# ADR 73 — AG-UI projection: the session event stream as the standard Agent↔User wire

**Status:** DRAFT 2026-07-09 (Fable, for Ryan — sibling to ADR 72). **Builds on:** the substrate
`EventBus` / `DiscreteEvent` / `ChannelEvent`, the `ClientEvent` surface (`spec/client/events.ts`),
client-next (state-sync via snapshot + `onStateChange`; `client.events()` reserved — the bus →
`AsyncIterable` adapter is **#308**), ADR 53 (steering), abort-as-command, the gateway + transports
(`in-process` / `ws` / `http`), ADR 23/26/27 (everything is a projection). **Sibling:** ADR 72 (the
`ui://` → A2UI *widget* seam — a DIFFERENT axis; the two compose).

## TL;DR

**AG-UI is the standard wire form of agentick's session *interaction surface*, which mostly already
exists.** It's an event-based Agent↔User protocol (message deltas, tool calls, event-sourced state
diffs, lifecycle, thinking + a return channel for input/interrupts/steering/state). Every one of
those maps to a primitive agentick already emits (the bus / `ClientEvent` surface) or accepts (the
session inbox). So AG-UI is a **thin codec** — `@agentick/ag-ui-next` on the gateway — not a new
model. It is a *different axis* from ADR 72's `ui://` widget seam: AG-UI is the run *feed*, A2UI is
the *widgets*; A2UI widgets can ride an AG-UI stream. **Closer to done** than the widget seam — the
substrate is here; the gaps are the streaming surface (#308) + the codec.

## The mapping — AG-UI event ↔ agentick primitive (both directions)

**Server → client (agentick bus / `ClientEvent` → AG-UI events):**

| AG-UI event | agentick source |
| --- | --- |
| message/text **deltas** | executor stream chunks (`AdapterDelta` / `stream:chunk`) + message events |
| **tool call / result** | `tool_use` / `tool_result` dispatch events on the bus |
| **state diff** (event-sourced) | knob / state / gate reactive changes + client state-sync (`onStateChange`, the handshake snapshot) |
| **lifecycle** (start/complete/interrupt/cancel) | execution `ClientEvent` phases (`started`/`completed`/`failed`) + abort |
| **thinking steps** | `reasoning` content blocks (ADR 57 signed-thinking round-trip; redaction respected) |
| **custom** | `log` / arbitrary bus events (`signals.ts` fan) |

**Client → server (AG-UI return channel → agentick inbox):**

| AG-UI return | agentick sink |
| --- | --- |
| user **input** (text / media) | `session.send({ messages })` |
| **interrupts** (pause / cancel) | abort-as-command (declared command on the session) |
| **agent steering** (mid-flow redirect) | ADR 53 steering — `session.queue` / new input appended mid-execution |
| **state mutations** | a knob set / `dispatch("set_knob")` / state write |

Every arrow is an existing seam. The client→server arrows all land on the **addressable session
inbox** — the same substrate the escalation relay (ADR 69) and `ui://` tool-calls (ADR 72) use.

## Why it's a projection, not a new model
We already own the bus, the execution lifecycle, the reactive state, and the inbox. AG-UI is a wire
*codec* over them — exactly as the MCP server harness projects tools/tasks/elicitation to the MCP
wire without owning them. Owning the native surface + projecting keeps us spec-stable: if AG-UI's
event vocabulary shifts, only the codec moves.

## Transport
AG-UI is **transport-agnostic** ("builds on HTTP/WebSockets as an abstraction layer"). It rides
agentick's existing transports — the `ws` / `http` transports already carry the gateway↔client
channel; AG-UI is a message *encoding* on that channel (SSE is the common AG-UI framing; our http
transport can serve it). No new transport, a new codec + framing.

## What's actually missing (the build)
1. **`client.events()` streaming surface (#308)** — the bus-`Stream` → `AsyncIterable` adapter is
   reserved but not built; AG-UI's server→client stream needs it (or the gateway emits AG-UI events
   directly off the bus).
2. **`@agentick/ag-ui-next`** — the gateway-side codec: bus/`ClientEvent` → AG-UI event frames, and
   AG-UI return frames → the session inbox (`send` / abort / steer / knob-set).
3. **Event-vocabulary coverage** — an audit of which AG-UI events map cleanly vs need a `custom`
   escape vs are lossy (esp. AG-UI's event-sourced shared-state diffs vs our snapshot +
   `onStateChange` — do we emit diffs or full snapshots?).

## Rejected
- **AG-UI as the native event model.** Couples the substrate to one spec. We own the bus + inbox
  and project (the ADR-40-inversion, same as ADR 72).
- **A separate AG-UI event system.** The bus IS the event system; AG-UI is a codec over it.
- **Bundling AG-UI into the `ui://` widget seam (ADR 72).** Different axis — event stream vs
  widgets. Separate packages (`@agentick/ag-ui-next` vs `@agentick/a2ui-next`); they compose.

## Open (workshop)
1. **State sync shape** — AG-UI wants event-sourced *diffs* for shared typed stores; agentick today
   does snapshot + `onStateChange`. Emit diffs, or send snapshots and let the client diff? (Knobs/
   state/gates are the shared store.)
2. **Thinking-steps mapping** — map `reasoning` blocks to AG-UI thinking events with the ADR-57
   redaction/signature rules honored (don't leak signed/redacted thinking).
3. **#308 dependency** — build the `client.events()` `AsyncIterable`, or have the gateway codec
   read the bus directly and skip the client-side adapter for the AG-UI path.
4. **Transport framing** — SSE (AG-UI's common framing) vs our `ws` transport; do both.
5. **Steering fidelity** — AG-UI "steering" (real-time redirect) ↔ ADR 53 steering semantics: is
   the mid-execution-append model a faithful mapping, or does AG-UI expect finer-grained control?
6. **Sub-agent / recursive delegation** — AG-UI notes compositional/sub-agent needs; map onto
   `spawn` + the lineage from ADR 69 T2a (a sub-agent's stream nested in the parent's).

@see ADR 72 (the sibling `ui://` widget seam) + its workshop artifact.
