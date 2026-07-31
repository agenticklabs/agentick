# Rooms — agentick as the communication substrate

**Status: WORKSHOP DRAFT** — 2026-07-31, Ryan + Fable. Nothing here is
scheduled; this is the argued design for multiplayer conversation on
agentick — user↔user chats, group chats, and every mixture of humans
and agents in one room. ⁇ marks the open questions. Companion product
sketch: Knowify "job rooms" (§12).

## 1. Thesis, and the forcing argument

> **A room is a session whose loop is optional and whose membership is
> plural. Agentick is the chat platform; human-only chat is the
> degenerate case, not a separate system.**

The argument is forcing, not aesthetic. Run the alternative: a separate
chat service beside agentick. It works for human↔human — until an agent
joins a group chat, which is the premise. At that moment the chat
service needs compilable timelines, tool execution, elicitation,
provenance, reconnect and abort semantics — the entire stack — and you
either bridge two substrates forever or re-import agentick wholesale.
One-substrate makes human-only rooms the cheapest case; two-substrate
makes agent-in-chat a permanent bridging tax. The asymmetry decides it.

What is already participant-agnostic (built, shipped, tested):

| Primitive                                | Multiplayer reading                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Timeline IS the conversation             | nothing in it assumes the counterparty is a model; entries already carry per-entry provenance (`MessageSource` keyed bag) |
| Channels (pub/sub)                       | real-time fan-out to N subscribers; presence/typing are small ephemeral tenants                                           |
| Gateway principals + transports          | per-connection identity, auth at the wire, reconnect semantics (never-stops, readiness)                                   |
| Elicitation + the ask dock               | "ask a user" becomes "ask a member"; the typed form stack renders it                                                      |
| Executions survive disconnect            | a room's agent turn doesn't die because one member's laptop lid closed                                                    |
| Spawn trees + destroy cascade            | threads/breakouts have lifecycle semantics already                                                                        |
| The composer stack                       | commands, entity pills, completion, typed forms — a business-grade chat input that never asks who is on the other end     |
| Session store seam + soft-delete pattern | room persistence is adopter policy, already proven                                                                        |

## 2. Why existing facts don't suffice (the null hypothesis)

1. **A session is single-principal today.** One implicit owner; the
   gateway authorizes the connection, not a membership. Two humans
   cannot both legitimately write one timeline.
2. **The loop runs on every send.** `session.send` implies "the model
   answers." A human-to-human message must append WITHOUT waking any
   model, and an agent member must decide _whether_ to speak — no seam
   expresses that today.
3. **No inbox.** A user in N rooms has no unread state, no
   notification surface; the current client model is one open session.
4. **Display identity ≠ auth identity.** Entries need "who said this"
   as a person (name, avatar), which principals don't carry.

Everything else is composition. These four are the genuinely new facts,
and they map to exactly three primitives plus a product surface —
which is the three-consumers-shaped budget this design must fit.

## 3. The model

### 3.1 Membership (the first new primitive)

A bundled harness per ADR 27 (`@agentick/membership`, private
workspace package, same pattern as timeline/knobs):

```ts
interface Member {
  readonly principalId: string; // auth identity (gateway's noun)
  readonly role: "owner" | "member" | "agent" | string; // open, adopter-extensible
  readonly display?: { name?: string; avatarRef?: string };
  readonly joinedAt: string;
}
// harness surface: add / remove / list / get; session:channel:membership
// notifications (added/removed/changed) — enumeration + topology, per the
// standing wire rule.
```

- Membership rides the **session record** (a `members` projection in
  meta or a first-class field ⁇) so `list_sessions` can answer "my
  rooms" without opening them.
- **Authorization moves from connection to membership.** The gateway's
  per-session check becomes: principal ∈ members (or app-declared
  policy callback — seam over setting, as ever). Non-members cannot
  subscribe, send, or list the room.
- An **agent is a member** with `role: "agent"` — uniform in the
  member list, so the client renders humans and agents with one code
  path, and mention pills (`@maria`, `@ernesto`) come from one source.

### 3.2 Sends that don't wake the model (the smallest change)

`session.send` grows a delivery discrimination — or cleaner: **append
vs send**. `timeline.append` already exists as the substrate verb; the
room contract is that a plain member message is an _append_ (broadcast
via existing live channels), and the loop is woken only by the
participation seam (§3.3). No new mechanism: the distinction between
"add to the conversation" and "run the agent" already exists in the
architecture — rooms just stop conflating them at the wire.

⁇ Wire shape: `session/append` as a first-class verb vs `session/send`
with `{ mode: "append" }`. Draft: a first-class verb — the two have
different journaling and authorization profiles, and flag-parameters
that change semantics are the enum-over-seam smell.

### 3.3 The participation seam (the second new primitive)

An agent member's loop is triggered by a verdict callback, not by
every message:

```ts
type Participation = (ctx: ParticipationCtx) => ParticipationVerdict;
// ctx: the appended entry, the member roster, this agent's identity,
//      recent-window accessor, whether the agent was @mentioned/addressed
// verdict: { speak: false } | { speak: true, after?: DebounceSpec }
```

Shipped defaults (generous, flippable — capability not opinion):
`onMention` (speak when @mentioned — the composer's mention pill makes
this reliable, not regex), `onAddress` (mention OR reply-to-agent),
`always` (1:1 assistant behavior — today's sessions are rooms with
`always`), `never` (listener/logger agents).

This is the gate/stopWhen twin — gate answers "does the loop
continue," participation answers "does the loop begin" — and it must
be a callback seam at the decision point, not a config enum.

- **Debounce/batching:** humans send in bursts; `after` lets a verdict
  say "speak once the room has been quiet for N seconds," folding the
  burst into one turn. Default on for group rooms.
- **Multiple agents ⁇ (roadblock, §9.2):** two `always` agents answer
  each other forever. Draft rule: an agent's own appends never trigger
  another agent's participation unless explicitly `@mentioned` —
  agent-to-agent requires addressing. Loud default against loops.

### 3.4 What the agent reads

A turn compiles the timeline as ever — the multi-party timeline IS the
context, with `source` identifying speakers. The compiler needs one
addition: a default renderer that labels entries by member display
name (the `<Timeline>` filter/render seam already exists for this; it
is a default, not a mechanism). Compaction is unchanged mechanically
but has a policy question (§9.3).

## 4. Wire surface

Mostly already planned or shipped:

| Verb                                                                                                                                                  | Status                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `app/destroy_session`, `gateway/destroy_session`                                                                                                      | in flight (2026-07-31)                                                                                                |
| `gateway/list_sessions` / `app/list_sessions` — cursor-paginated, principal-scoped ("my rooms"), records carry appId + members + meta (title/preview) | next slice; the conversations panel moves onto it                                                                     |
| `session/append`                                                                                                                                      | new (§3.2)                                                                                                            |
| `session/members/*` (add/remove/list) + membership channel                                                                                            | new, standard enumerate+topology shape                                                                                |
| presence / typing / receipts                                                                                                                          | ephemeral channels, bus-only journaling disposition (the `WireExtension.journal` knob shipped for exactly this class) |

Everything else — send, abort, subscriptions, elicitation, knobs,
completions — is already multi-consumer-safe or becomes so via
membership authorization.

## 5. Identity

- **Principal = auth identity** (gateway, Knowify auth source today).
  **Member.display = presentation identity.** The two are linked at
  join time by the app (Knowify knows its users; the framework does
  not want to).
- Entries stamp `source.member = { principalId }` at append —
  framework stamps only what it holds at act time (the provenance
  razor); display resolution is a client concern via the roster.
- ⁇ Guests/external members (a sub without a Knowify login, a client
  of the contractor): representable as principals minted by the app's
  auth source; the framework needs nothing, but the product needs a
  policy. Parked until a tenant.

## 6. Persistence & scale profile

The inversion to design for: today = few sessions × heavy compute;
rooms = many sessions × light traffic × long idle. Already-held cards:

- **Idle eviction + resume** exist (`sweepIdle`, create-or-resume). A
  dormant room costs a row, not a process. Hibernation is the default
  behavior, not a feature.
- **Journaling policy** already supports per-channel/per-verb
  dispositions — presence/typing stay off the durable journal.
- **Store seam** is adopter-owned; Knowify's Postgres store scales the
  ordinary way. Cursor pagination is already the house shape.
- ⁇ Cluster ordering: two members appending via two nodes — the
  cluster layer's session affinity answers this today (one session,
  one owning node); worth restating as a room invariant rather than
  re-deriving.

## 7. Inbox & notifications (the third new primitive)

Per-member read cursors: `lastReadAt`/`lastReadEntryId` per (member,
room), written by the client, served with `list_sessions` so the rooms
list renders unread counts in one query. Push/badging beyond the open
client is a product integration (Knowify already has notification
rails), not framework. ⁇ whether cursors live in session meta (cheap,
per-room doc) or a store table (queryable "total unread across
rooms") — draft: store table, because the badge-count query is the
whole point.

## 8. Pathways (staged, each independently shippable)

- **P1 — plural writers.** Membership harness + membership-based
  gateway authz + `session/append` + source.member stamping + roster
  channel. Prove with two principals in one session and zero UI: the
  conformance suite is the customer.
- **P2 — the agent joins.** Participation seam + `onMention` default +
  debounce. Today's 1:1 assistant re-expressed as a 2-member room with
  `always` — the regression suite for "nothing changed."
- **P3 — the room feels live.** Presence/typing/receipt channels +
  read cursors + `list_sessions` unread projection.
- **P4 — the panel becomes rooms.** Knowify client: rooms list over
  `gateway/list_sessions`, member roster UI, @-mentions of humans
  (mention pills already exist), the dock asking specific members.
- **P5 — job rooms** (§12) and whatever product proves out.

Sequencing note: P1 rides naturally behind the destroy/list wire work
already in flight; nothing in P1 blocks on P2+.

## 9. Roadblocks (hard, must be argued before their phase)

1. **Privacy expectation vs. compilable timeline.** Humans chatting
   expect "the AI reads this" to be explicit. The timeline IS model
   context by design — so agent membership must be visible, joining
   must be an event in the room, and ⁇ whether an agent's compile
   window may include messages from before it joined (draft: no by
   default — join-time horizon stamped on the member record; flippable
   per room). This is the one place the substrate's greatest strength
   is the product's biggest landmine.
2. **Multi-agent arbitration.** Two agents, one mention-storm. The
   no-unaddressed-agent-triggers rule (§3.3) is the floor; anything
   richer (turn tokens, moderator agents) waits for a real tenant.
3. **Compaction of multi-party history.** Whose salience wins when the
   room compacts — the agent's task-relevance or the humans' record?
   Draft: compaction serves the AGENT'S context only and never rewrites
   the durable timeline (it never does today — restating it as a room
   invariant); humans always scroll the real history.
4. **Elicitation addressing.** `elicit.text(...)` must say WHICH
   member (or "any member with role X"). The escalation-chain work
   (ADR 69) already threads ownership; this generalizes its address
   from "the user" to "a member ref" — contract change, not new
   machinery, but it touches the dock, tasks, and MCP projection.
5. **Cost model.** An `always` agent in a busy room burns tokens on
   chatter. Debounce is the mechanism; the product needs a policy
   surface (per-room agent budget ⁇ — knobs are sitting right there).

## 10. Speedbumps (known, priced, not dangerous)

- **Naming**: "channel" is taken by pub/sub; the object is a **room**
  (or stays "session" in the framework with "room" as product
  vocabulary — draft: framework says session + membership; only
  products say room).
- **Roles on entries**: multi-human breaks the user/assistant binary
  reading. Entries keep protocol roles (a human is `user`); identity
  lives in `source.member`, rendering lives client-side. No schema
  break.
- **Editing/deleting messages**: timelines are append-only; edits are
  tombstone/supersede entries (the timeline's edit semantics ⁇ — one
  design short of settled, needed by P4, not before).
- **Typing indicator chattiness**: throttle client-side, ephemeral
  channel, never journaled.
- **Rate limiting / abuse**: gateway guard seam per verb — exists.

## 11. What the design deliberately does not decide

Threads-in-rooms (forks exist and cascade correctly — whether product
threads are forks or filtered views is a P4+ product call). Search
(store-level concern; the timeline store can index; nothing in the
room contract changes it). Federation beyond one gateway. E2E
encryption (incompatible with agent members by definition; per-room
"no agents may join" is the honest variant). Moderation tooling.

## 12. Opportunities — what this design makes cheap later

- **Job rooms (the Knowify product thesis).** A room per job: PM,
  foreman, subs, and Ernesto as members. `#job:1042` pills, `/`
  commands, typed dock forms, and agent-performed writes are native
  speech. Slack structurally cannot be this — its participants can't
  act on the books. The room's `meta` binds it to the job entity; the
  agent's tools scope to it (guards by room meta).
- **Approvals as room speech.** Elicitation-to-a-member IS an approval
  workflow: the agent asks the PM, in the room, with a typed form, and
  the answer is provenance-stamped in the timeline. An approvals
  product falls out of §9.4 with zero new mechanism.
- **Agents as coworkers.** The tasks harness + membership: assign a
  task to the agent member in-room; escalations land back in the room
  as asks. Standup/reporting agents are participation `schedule`
  verdicts (gates + cron shapes already exist).
- **Listener agents.** `participation: never` + timeline subscription
  = summarizers, compliance watchers, memory writers — agents that
  never speak but always know. The provenance model keeps them honest.
- **Announcement/broadcast rooms.** One writer role, N readers — a
  role policy, not a feature.
- **External bridges.** An email/SMS bridge is a member whose
  "client" is a connector: the membership abstraction makes bridges
  ordinary members, which is how a sub without the app answers the
  foreman from a text message.
- **Cross-room agent memory.** The recall/remember tools scoped by
  principal rather than session — rooms make "the agent knows our
  history" a query, not a migration.
- **The composer as the universal input** — every investment in the
  grammar (defineNode, entity pills, schema forms) compounds across
  every room forever. This is the "we built a ton of cool chat stuff
  already" observation made structural: rooms are the surface that
  amortizes it.

## 13. Verification posture

P1 lands with conformance: two principals appending, non-member
refused at subscribe/send/list, roster notifications, source.member
stamped, single-principal sessions byte-identical (the regression
suite IS the 1:1 assistant). P2 lands with the participation matrix
pinned (mention/address/always/never × debounce) and the two-agent
no-loop rule as a test, not a hope. Every claim in §12 stays out of
prose until its tenant exists — this section is a map, not a promise.
