# User Conceptual Context For Project

- Must consider ways to make this system malleable. That means agent can evolve the system.
  - obviously a system tool that can create and execute new instances of agents.
  - means being able to write agents in jsx? means running all in a sandbox?
  - means agents being able to discover and communicate with each other within the graph?
    - what does that look like?
  - means being able to author their own tools and make them available at large?
  - means being able to re-write the framework? crazy....
  - means being able to **\_**

- TUI
- readline input component
- slash commands
- what is a command? tool? approval/confirmation system?
- advanced terminal input

---

## Agent Architecture Notes (Brainstorm)

### Primitives

**spawn(Component, props?)** — Fresh session, clean timeline, new identity. Delegating a task.
**fork()** — Snapshot current session, hydrate into new session. Speculative execution / branching. SessionSnapshot + hydration already exists.

Both return an **AgentHandle**:

```
AgentHandle {
  id, status (signal),
  send(msg), onMessage(cb),   // communication
  steer(input), pause/resume/kill,  // control
  result: Promise<any>         // completion
}
```

### Communication: Channels All The Way Down

No new transport primitive. Channels already do pub/sub + request/response + routing.

**Naming convention per agent:**

- `agent:{id}:inbox` — messages TO agent
- `agent:{id}:outbox` — messages FROM agent (activity stream)
- `agent:{id}:status` — lifecycle events
- `graph:broadcast` — announcements to all agents

**Message flow:**

- Parent→Child: parent publishes to child's inbox
- Child→Parent: child publishes to parent's inbox (knows parent from registry)
- Agent→User: agent publishes to its outbox; UI subscribes to all outboxes
- User→Agent: UI publishes to agent's inbox (that's "steering")

### Registry

App-level (or graph-level) registry of all active agents:

```
agent-id → { component, capabilities, parent, status, channels }
```

Agents register on spawn/fork. Discovery tool queries the registry.

### useKnob — Model-Visible Reactive State

A hook that combines useState + auto tool generation + context rendering:

```typescript
const [mode, setMode] = useKnob("mode", {
  description: "Operating mode: broad vs deep",
  default: "broad",
});
```

Under the hood:

1. Creates reactive state (signal)
2. Renders <Section> into model context with value + description
3. Registers/contributes to a `set_knob` tool
4. Model can introspect and set its own operating parameters
5. User can also set knobs via channels (same mechanism, different caller)

### Sandbox + REPL

One tool (`repl`) backed by a sandboxed runtime (isolated-vm or vm.Module).

**Curated sandbox globals:**

- `spawn()`, `fork()` — lifecycle
- `discover()`, `send()`, `broadcast()` — communication
- `setKnob()` — self-modification
- Access to agent's own tools (call programmatically)
- `Promise`, `async/await` — orchestration

**Sandbox restricts:** no fs, no raw net, memory/CPU limits, timeouts.

The REPL IS the orchestration surface. Agent doesn't need 15 tools for orchestration — it composes operations in code. That's the malleability.

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ GATEWAY — The external membrane                              │
│                                                              │
│  Transports:  WS, SSE, HTTP (clients connect here)          │
│  Connectors:  WhatsApp, Slack, Email, Webhooks, Browser      │
│  Pipeline:    dedup → debounce → validate → route → queue    │
│  Infra:       Auth, SessionManager, AppRegistry, Persistence │
│                                                              │
│  Routes to ROOT sessions only.                               │
│  Bridges root session channels to external transports.       │
│  Does NOT know about sub-agents or graphs.                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ root sessions only
┌──────────────────────────┴──────────────────────────────────┐
│ SESSION — The universal primitive (self-similar at all depths)│
│                                                              │
│  Every session, whether root or spawned, has:                │
│  Component tree (JSX), Model, Tools, Timeline,               │
│  Hooks, COM, Signals, Channels, spawn(), fork()              │
│                                                              │
│  spawn() = tool call that creates a child session.           │
│  fork() = snapshot self → new child session.                 │
│  Children are full sessions. The tree is emergent.           │
│  A sub-agent at depth 5 has the same capabilities as root.   │
└─────────────────────────────────────────────────────────────┘
```

### Key Insight: Self-Similarity (Fractal Architecture)

**A session is a session is a session.** There is no "AgentGraph" as a separate concept.
Sessions can create child sessions via spawn/fork. The graph emerges from the tree,
like Unix processes. There's no ProcessGraph — just fork/exec and the process tree.

```
Session
├── Component tree, Model, Tools, Timeline, Hooks, COM, Channels
├── parent: Session | null  (null = root, gateway-managed)
├── children: Session[]     (spawned sub-sessions)
├── spawn(Component, props) → AgentHandle
├── fork()                  → AgentHandle
└── Children are full Sessions (recurse)
```

| Pattern                 | Root level                | Sub-agent level           |
| ----------------------- | ------------------------- | ------------------------- |
| Messages arrive from... | Gateway (user/connectors) | Parent (via spawn task)   |
| Results go to...        | Gateway (user's UI)       | Parent (tool return)      |
| Can spawn children?     | Yes                       | Yes                       |
| Can use REPL/sandbox?   | Yes                       | Yes                       |
| Can be steered?         | Yes (user via gateway)    | Yes (parent via channels) |
| Can be hibernated?      | Yes                       | Yes (same mechanism)      |
| Can bind connectors?    | Yes (common)              | Yes (rare, but possible)  |

An agent doesn't know if it's root or spawned. Same component works in both contexts.

### spawn() = Tool Call (The Core Mental Model)

**Default: blocking.** spawn() creates a sub-session, runs it, returns the result.
From the parent's perspective, it's just a slow tool call.

```
Parent tick:
  Model → spawn_agent tool → sub-session runs → result returns
  (just a tool call that happens to create a session internally)
```

**Parallel spawns = parallel tool calls.** Model calls spawn 3x in one tick,
3 sub-agents run concurrently, tick blocks until all complete.

**Fire-and-forget = opt-in.** Return immediately with a handle. Sub-agent runs
in background. Result injected into parent's timeline later, triggering new execution.

### Two Kinds of Inter-Agent Communication

**1. spawn() — Parent-child, hierarchical (AgentGraph, common)**
Agent spawns sub-agent as a tool call. Child is short-lived, returns result, closes.
The "graph" is just the session tree.

**2. Inter-session messaging — Peer-to-peer across root sessions (Gateway-level, rare)**
Querying an existing persistent session's history or sending it a message.
Different use case: "what did we discuss yesterday?" not "do this task for me."

### Connectors (not "Channels")

External platform adapters. Built ON channels but are a higher-level abstraction.
"Channels" = internal pub/sub primitive. "Connectors" = external world adapters.

**Bidirectional:**

- Inbound: external event → connector → channel event on session
- Outbound: agent action (tool/REPL) → connector → external API call

**Hierarchical configuration:**

- Gateway level: infrastructure (credentials, webhook URLs)
- App level: availability ("this app can use whatsapp")
- Session level: binding ("this session = whatsapp:+1234567890")

A connector bound to a sub-agent means it receives external messages directly,
same as a root session receives user messages through gateway. Self-similar.

### Queueing Modes (from messaging.md, applies at all levels)

When a message arrives at a running agent (user steering, parent message, etc.):

- **interrupt**: cancel current tick, restart with new input
- **steer**: inject into current execution mid-tick
- **followup**: queue, process after current tick completes
- **collect**: batch messages together, process as group

Per-agent configuration, not global.

### Channel Scoping (Multi-User Isolation)

Instead of ugly prefixed names, channels live inside scopes:

```
Scope (user/session/ad-hoc boundary)
├── inbox        (simple names within scope)
├── outbox
├── status
└── notifications
```

- Scope provides isolation (like k8s namespaces)
- Within a scope, names are simple and collision-free
- Cross-scope channels bridge between scopes (shared/collaborative)
- Session tree = natural scope hierarchy

### Agent Lifecycle States

```
spawned → running → idle → completed
                 ↘ error
```

- **running**: mid-tick. NOT hibernatable.
- **idle**: waiting for input. Hibernatable.
- **completed**: done, result available. Hibernatable or GC-able.
- **error**: failed, preserves error state.

Graph hibernation: only when all agents are idle/completed/error.
Registry is serializable. Sub-agents hydrate lazily on demand.

### Multi-Agent Conversations

**Scenario 1: Different specialists in one conversation (common)**
One root session acts as coordinator. Spawns sub-agents as tool calls when it
needs specialist help. Root session's timeline IS the shared record.

**Scenario 2: Multiple agents independently participating (group chat)**
If external platform (Slack, Discord): the platform IS the shared record.
Multiple agent sessions bind to the same channel via connectors.
If native web UI: coordinator session manages routing, children contribute
to the root timeline via channels. Pattern built on Scenario 1.

The shared record is always a session's timeline. The question is just: whose session?

### Open Questions

- How do forked agents diverge? Do they share the parent's tool set, or snapshot it?
- Can agents spawn agents of a DIFFERENT component type than themselves? (yes, almost certainly)
- Lifecycle on child completion: auto-cleanup? Persist for queries?
- Graph topology as observable: channel stream? DevTools integration?
- REPL: persistent sandbox (stateful across ticks) or fresh each invocation?
- Can an agent promote a forked agent's result back into its own timeline?
- Multi-tenancy: deferred but designed-for

---

## Claude's Architectural Insights & Proposals

> The following are Claude's (the AI assistant) observations and proposals from
> brainstorming sessions. These represent analysis and suggestions for the project
> owner to evaluate — not decisions. They should be weighed against practical
> experience and product intuition.

### Proposal: Virtual Actor Session Lifecycle

Sessions should follow the **Virtual Actor** pattern (Microsoft Orleans, Akka).
A session is logically persistent but physically ephemeral. It doesn't "stay open"
or "close" in the traditional sense — it's always conceptually alive, but its
in-memory presence is managed by the infrastructure.

```
Request arrives for session X
  → Is X in memory? (warm)
    → Yes: route to it, execute
    → No: hydrate from storage, execute
  → After execution:
    → Stay warm (likely follow-up coming)
    → After idle timeout: hibernate to storage (free memory)
    → On memory pressure: evict LRU sessions
```

**The analogy**: opening an app on your phone. The OS doesn't destroy it when you
switch away — it suspends it. When you come back, it resumes instantly. If the OS
needs memory, it kills the suspended app. Next time you open it, it cold-starts
from saved state. The user doesn't know the difference.

Sessions work the same way:

- **Logically persistent**: identity, state, timeline survive across requests
- **Physically transient**: in-memory presence is managed, not guaranteed
- **Transparent lifecycle**: the agent doesn't know if it was warm or cold-started

This is what agentick's `SessionRegistry` + `SessionSnapshot` + hibernation
already provides (or is designed to provide). The key is making this the
**explicit mental model**, not an optimization detail.

**What gets persisted** (to Postgres, SQLite, whatever):

- Timeline (conversation history)
- COM state, signal values, knob values
- Children metadata (session tree structure, sub-agent results)
- Usage stats (tokens, ticks, timestamps)

**What doesn't persist** (reconstructed on hydration):

- Running execution state (can't hibernate mid-tick)
- Active model connections
- Sandbox runtime state (open question — maybe it should?)

### Proposal: Distributed Sessions — One Instance at a Time, Anywhere

In a multi-server deployment, the only invariant: **one instance at a time.**
Sessions are portable. Storage (Postgres, etc.) is the source of truth.
Servers are just temporary hosts.

```
Session X is warm on Server A
  → Requests route to A (sticky while warm — optimization, not constraint)
  → A hibernates X to storage
  → X is now homeless, lives nowhere

New request arrives for X
  → Any server can hydrate it (whoever gets the lock first)
  → Server C hydrates X, requests now route to C
  → C is the home until next hibernation
```

**Scaling = more sessions across more servers**, not more copies of one session.
No synchronization between servers — only one copy exists at a time.
Sticky routing is an optimization (avoid unnecessary hydration), not architecture.

This is exactly how actor systems (Orleans, Akka), game servers, and chat
servers work. Well-understood pattern with known tradeoffs.

### Proposal: Multi-User Isolation via Transparent Scoping

The gateway adds a user scope to session keys invisibly. App code never
mentions users or tenants.

```
Alice requests "chat:main"  →  Gateway stores as scope(alice):chat:main
Bob requests "chat:main"    →  Gateway stores as scope(bob):chat:main
```

Both users think they have "chat:main." They do — completely separate instances.
The scoping is invisible to agent code, component code, and tools.

Like database row-level security: the query doesn't filter by tenant,
the infrastructure does.

- Agent code never mentions users or tenants
- Channels are auto-scoped (they belong to a scoped session)
- Session tree inherits parent's scope
- Multi-tenancy is the same mechanism, one more scope layer (deferred)

### Observation: The Reconciler vs. Simplicity (pi comparison)

Compared agentick's React reconciler approach against pi-mono (badlogic/pi-mono),
a minimal agent framework with four types (Message, Context, Model, Tool) and
a simple event-emitting loop.

**What pi gets right:**

- The loop is visible and obvious
- Steering/follow-up modes are first-class
- No conceptual overhead — just a loop with tools

**What the reconciler buys agentick:**

- Declarative, composable context description (JSX)
- Reactive updates (state change → model sees new context automatically)
- Composition (package behaviors as components, drop into any agent)
- `useKnob()` — simultaneously creates state, renders to context, registers tool.
  This is uniquely clean in a component model and very hard to do well imperatively.

**Where the reconciler may be overkill:**

- Fiber tree, scheduling, effects lifecycle, concurrent mode — these are powerful
  React features that may not all be necessary for "declarative reactive context"
- For simple agents (system prompt + tools + loop), the reconciler adds complexity
  without proportional benefit

**Proposal**: Keep the reconciler — it works, it's tested (1253 tests), developers
know JSX, and it enables knobs/reactive context beautifully. But recognize it as
an **implementation choice, not the architecture**. The architecture is sessions.
The reconciler is how you define context inside one kind of session.

Could even support both:

```typescript
// Full component tree (context engineering, complex agents)
const app = createApp(MyAgentComponent, { model });

// Simple loop (pi-style, template agents)
const app = createApp({
  system: "You are a research assistant.",
  tools: [searchTool, writeTool],
  model: claude,
});
```

Both produce sessions. Both can spawn. Both can use knobs. Both hibernate the
same way. The reconciler is one way to fill a session's internals, not the
only way.

### Core Thesis: The Session IS the Architecture

The valuable thing isn't the reconciler. It's the **session**.

The session — with its identity, persistence, lifecycle, spawn/fork, channels,
connectors, and knobs — is the real architecture. Everything we've designed
(agentic features, multi-user isolation, distributed deployment, multi-agent
conversations) attaches to the session primitive, not to the reconciler.

Pi doesn't have sessions. It has an agent loop that runs and emits events.
When it's done, it's done. No persistence, no hibernation, no spawn, no channels.

agentick's session IS the thing. It's the container for:

- Agent identity and lifecycle (virtual actor pattern)
- State persistence and hydration
- Parent-child relationships (spawn/fork, emergent graph)
- Communication (channels, connectors)
- Agent self-modification (knobs)
- Orchestration (REPL/sandbox)
- Context definition (reconciler OR simple loop — the session doesn't care)

**The architecture is sessions all the way down.** Fractal, self-similar, one
primitive that composes at every level. Gateway routes to root sessions. Sessions
spawn child sessions. Children spawn grandchildren. Every level has the same
capabilities. The complexity of the system emerges from the composition of
simple, identical building blocks.

### Summary of Key Architectural Decisions (Proposed)

| Decision             | Recommendation                                           | Rationale                                          |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Session lifecycle    | Virtual actor (warm/hibernate/hydrate)                   | Well-understood, scalable, transparent             |
| Distributed model    | One instance per session, sticky routing                 | No sync needed, clean handoff                      |
| Multi-user isolation | Gateway-level transparent scoping                        | App code stays clean, infrastructure handles it    |
| Agent graph          | Emergent from session tree (no explicit "graph")         | Self-similar, no special cases                     |
| spawn() semantics    | Default blocking (tool call), opt-in async               | Simple mental model, covers 90% of cases           |
| Inter-agent comm     | spawn for delegation, gateway messaging for peer queries | Two patterns, clearly separated                    |
| Connectors           | Bidirectional adapters, hierarchical config              | Gateway infra → app availability → session binding |
| Queueing modes       | interrupt/steer/followup/collect, per-agent              | From messaging.md, applies at all session levels   |
| Reconciler           | Keep, but recognize as implementation detail             | Works well, enables knobs, not the architecture    |
| Knobs (useKnob)      | First-class primitive                                    | Killer feature for agent self-modification         |
| Sandbox/REPL         | Composable orchestration surface                         | Enables malleability without 15 individual tools   |

### What Remains Unresolved

- **Knob implementation details**: Single `set_knob` tool or one tool per knob? Typed values or free-form?
- **Sandbox scope**: Persistent across ticks (stateful REPL) or fresh each invocation?
- **Connector configuration**: Config file? Runtime values? How does inheritance work exactly?
- **fork() semantics**: What exactly gets snapshotted? Tools, state, timeline, children?
- **Fire-and-forget completion**: How exactly does result injection + new execution trigger work?
- **Resource limits**: Max spawn depth, max children, max tokens across graph
- **Multi-agent conversation UX**: How does the user experience multiple agents in one chat?
- **Whether to support non-reconciler sessions**: Is the simple config-based createApp worth building?

### Late Insight: JSX as Internal IR, Not User-Facing Requirement

> Added after further discussion. This reframes the entire relationship between
> the reconciler and the user-facing API.

The simple config-based `createApp({ system, tools, model })` doesn't bypass
the reconciler — it uses a **default component** internally. The reconciler is
always there. JSX is the internal representation. Users don't have to see it.

```typescript
// What the user writes (simple path):
const app = createApp({
  system: "You are a research assistant.",
  tools: [searchTool, writeTool],
  model: claude,
});

// What the framework does internally:
// → Creates a DefaultAgent component from this config
// → DefaultAgent renders: <System>, <Tool>s, <Timeline>, <Model>
// → Reconciler compiles it like any other component tree
// → User never sees JSX

// When the user needs more power, they write the component directly:
const app = createApp(MyCustomAgent, { model });
```

**This means:**

- The reconciler is ALWAYS used. It's not optional overhead — it's the engine.
- JSX is the framework's internal language, like an IR or AST.
- The user-facing API can be as simple as `new Agent(config)` (pi-style).
- Power users drop into JSX when they need reactive context, knobs, conditional
  tools, composition — no framework switch, no migration.
- The "default agent component" is itself a useful reference implementation:
  it shows how the framework renders a simple agent, and users can copy/modify it.

**This resolves the reconciler debate entirely.** It's not "reconciler vs simple."
It's "simple API on top, reconciler underneath, JSX escape hatch when needed."
The framework meets users where they are and grows with them.

### Proposal: The Progressive Disclosure On-Ramp

The default agent component (working name: `<Agent>`) is exposed publicly.
Users can use it as-is, wrap it with hooks, or replace it entirely.
Four levels of engagement, each a natural step from the previous:

**Level 0: Config only.** No JSX. No React knowledge.

```typescript
const app = createApp({
  system: "You are a research assistant.",
  tools: [SearchTool, WriteTool],
  model: claude,
});
// Internally creates a DefaultAgent component and renders it.
```

**Level 1: Wrap `<Agent>`, add hooks and children.** The gateway drug.
User learns one thing: "I can add hooks and children."

```tsx
function MyAgent() {
  const [depth] = useKnob("depth", {
    description: "Research depth: quick scan vs deep dive",
    default: "quick",
  });

  useContinuation((result) => !result.text?.includes("<DONE>"));

  return (
    <Agent system="You are a research assistant." model={claude}>
      <SearchTool depth={depth} />
      <WriteTool />
      <Section id="guidelines">Always cite sources. Prefer recent papers.</Section>
    </Agent>
  );
}
```

**Level 2: Props-driven, reusable agents.** Same component, different behavior.

```tsx
function ResearchAgent({ topic, style, model }) {
  const [depth] = useKnob("depth", {
    description: "Research depth",
    default: "thorough",
  });

  return (
    <Agent system={`You research ${topic}. Style: ${style}.`} model={model}>
      <SearchTool depth={depth} />
      {style === "academic" && <CitationTool />}
    </Agent>
  );
}

// One component, many agents:
createApp(ResearchAgent, { props: { topic: "quantum computing", style: "academic" } });
createApp(ResearchAgent, { props: { topic: "competitor analysis", style: "brief" } });
```

**Level 3: Full custom.** No `<Agent>` wrapper. You own everything.

```tsx
function OrchestratorAgent({ agents }) {
  const [strategy] = useKnob("strategy", {
    description: "How to coordinate sub-agents",
    default: "parallel",
  });

  return (
    <>
      <System>
        You coordinate specialist agents. Available: {agents.map((a) => a.name)}
        Current strategy: {strategy}
      </System>
      <SpawnTool agents={agents} />
      <Timeline />
      <Model model={claude} temperature={0.2} />
    </>
  );
}
```

**The `<Agent>` component itself is trivially simple:**

```tsx
function Agent({ system, model, tools, children, ...modelProps }) {
  return (
    <>
      {system && <System>{system}</System>}
      {tools?.map((T) => (
        <T key={T.metadata.name} />
      ))}
      {children}
      <Timeline />
      <Model model={model} {...modelProps} />
    </>
  );
}
```

It just renders boilerplate so you don't have to. Children slot in alongside
defaults — extra tools, sections, knobs (which auto-render their own
sections + tools via the reconciler). Timeline and Model go at the bottom.

**On-ramp summary:**

| Level | User knows                 | User writes          | Escape hatch               |
| ----- | -------------------------- | -------------------- | -------------------------- |
| 0     | Nothing about React        | Config object        | Wrap `<Agent>`             |
| 1     | "Hooks and children exist" | Function + `<Agent>` | Add props, conditionals    |
| 2     | Props, composition         | Reusable components  | Drop the `<Agent>` wrapper |
| 3     | The full component model   | Custom JSX           | You ARE the framework      |

Each level is a natural step. No walls, no rewrites, no framework switches.
You just open the hood a little more when you need to.

**Naming**: `Agent` is clean but possibly too generic (conflicts with the concept).
Candidates: `Agent`, `BaseAgent`, `AgentShell`, `ToolAgent`. TBD.

---

### Agent Definitions as Markdown (Future: `loadAgent()`)

> Inspired by pi-messenger's agent definitions (markdown + YAML frontmatter).

Agents should be definable as plain markdown files:

```markdown
---
name: crew-worker
model: claude-opus-4-5
tools: [read, write, edit, bash]
role: worker
maxTicks: 50
knobs:
  depth:
    default: "thorough"
    description: "How deeply to investigate before acting"
    options: ["quick", "thorough", "exhaustive"]
---

You are a crew worker. You complete assigned tasks precisely.
Focus on one file at a time. Run tests after every change.
```

`loadAgent("./agents/worker.md")` parses the frontmatter into an `AgentConfig`,
uses the markdown body as the system prompt, and returns an app via `createAgent()`.
The reconciler runs underneath. The user never sees JSX.

**Why this matters:**

- **Version-controllable.** Agent definitions live in git alongside code.
- **Human-readable.** Non-developers can read and edit agent behavior.
- **Hot-reloadable.** Watch the file, reload on change. Agent tuning without restart.
- **Composable.** `loadAgent()` returns a normal app — use it with `spawn()`,
  pass it as a tool, run it standalone. Same object regardless of how it was defined.
- **Knobs in frontmatter.** Declarative knob definitions that the model interprets
  as context (Level 0). No code needed for behavioral tuning.

The tool references (`tools: [read, write, edit, bash]`) need a tool registry —
string names mapped to actual ToolClass instances. This could be per-app or global.
Same pattern as model references (`model: claude-opus-4-5` → actual ModelClass).

This is Level -1: agents defined entirely as data files. Below even the config
object. The on-ramp extends down.

---

### Cross-Gateway Federation (Sketch)

> Added after analyzing pi-messenger (nicobailon/pi-messenger) — a filesystem-based
> multi-agent coordination system for the Pi coding agent. Pi-messenger builds all
> coordination (registry, messaging, activity feeds, file reservations) on the
> filesystem. agentick has the right primitives (channels, adapters, connectors)
> designed as interfaces, not implementations. The question: can federation be a
> plugin? Answer: 80% yes today. The 20% gap is session addressing.

#### What Already Works as Plugin (No Core Changes)

**Channel bridging.** The core `ChannelAdapter` interface is the right seam.
`RedisChannelAdapter` already demonstrates the pattern: local events → external
system → subscribe to remote events. A `FederationChannelAdapter` does the same
thing but bridges across gateway boundaries instead of Redis topics.

**Inbound routing.** The gateway connector interface gives plugins `GatewayContext`
with `sendToSession()`. A federation connector receives messages from remote
gateways and injects them locally. Same pattern as WhatsApp/Slack — the remote
gateway is just another "external platform."

**RPC surface.** Gateway custom methods (`GatewayConfig.methods`) let a plugin
expose `federation.forward`, `federation.discover`, `federation.heartbeat` as
procedures with middleware, auth guards, etc.

#### The Gap: Session Addressing

Session keys are currently `appId:sessionName` — flat, purely local. The
`SessionManager` always creates sessions locally. There's no "this session lives
on gateway X" concept.

**Proposed fix: `SessionAddress` + pluggable resolver.**

```typescript
// packages/gateway/src/session-address.ts

/**
 * A session address that can reference local or remote sessions.
 *
 * Local:  "chat:main"           → { app: "chat", name: "main" }
 * Remote: "gw-b/chat:main"     → { app: "chat", name: "main", gateway: "gw-b" }
 *
 * The gateway field is optional. When absent, the session is local.
 * When present, SessionManager delegates to the registered SessionResolver.
 */
interface SessionAddress {
  app: string;
  name: string;
  gateway?: string; // undefined = local
}

function parseSessionAddress(key: string, defaultApp?: string): SessionAddress {
  // "gw-b/chat:main" → gateway="gw-b", app="chat", name="main"
  // "chat:main"       → gateway=undefined, app="chat", name="main"
  const slashIdx = key.indexOf("/");
  if (slashIdx !== -1) {
    const gateway = key.slice(0, slashIdx);
    const rest = key.slice(slashIdx + 1);
    const parsed = parseSessionKey(rest, defaultApp);
    return { ...parsed, gateway };
  }
  return parseSessionKey(key, defaultApp);
}
```

```typescript
// packages/gateway/src/session-resolver.ts

/**
 * Pluggable session resolver. Default is local-only.
 * Federation plugin replaces this with a remote-aware resolver.
 */
interface SessionResolver {
  /** Can this resolver handle sessions on the given gateway? */
  canResolve(gateway: string): boolean;

  /** Forward a send request to a remote gateway. */
  send(address: SessionAddress, input: SendInput): Promise<SessionExecutionHandle>;

  /** Forward a method call to a remote gateway. */
  call(address: SessionAddress, method: string, params: unknown): Promise<unknown>;
}
```

```typescript
// SessionManager changes (~10 lines)

class SessionManager {
  private resolver?: SessionResolver;

  /** Plugin registers a resolver. */
  setResolver(resolver: SessionResolver): void {
    this.resolver = resolver;
  }

  async send(key: string, input: SendInput): Promise<SessionExecutionHandle> {
    const address = parseSessionAddress(key, this.defaultApp);

    // Remote? Delegate to resolver.
    if (address.gateway && this.resolver?.canResolve(address.gateway)) {
      return this.resolver.send(address, input);
    }

    // Local? Existing behavior.
    const session = await this.getOrCreate(address);
    return session.send(input);
  }
}
```

**What the federation plugin implements:**

```typescript
// @agentick/federation (plugin package)

class FederationResolver implements SessionResolver {
  private peers: Map<string, PeerGateway>; // gateway-id → connection info

  canResolve(gateway: string): boolean {
    return this.peers.has(gateway);
  }

  async send(address: SessionAddress, input: SendInput) {
    const peer = this.peers.get(address.gateway!);
    // Forward via gRPC/HTTP to the peer gateway's /send endpoint
    return peer.client.send({ app: address.app, name: address.name, input });
  }
}

class FederationChannelAdapter implements ChannelAdapter {
  // Bridges channel events across gateways.
  // Local publish → forward to peers subscribed to this channel pattern.
  // Remote events → inject into local ChannelService.
}

class FederationConnector implements GatewayChannelAdapter {
  // Gateway connector that:
  // - Registers the resolver on the SessionManager
  // - Sets up the FederationChannelAdapter on the ChannelService
  // - Manages peer discovery (heartbeats, registry)
  // - Exposes inbound endpoints for peer gateways to call

  async initialize(gateway: GatewayContext) {
    gateway.sessionManager.setResolver(this.resolver);
    gateway.channelService.addAdapter(this.channelAdapter);
    this.startHeartbeats();
  }
}
```

#### The Architecture With Federation

```
Gateway A (gw-a)                        Gateway B (gw-b)
┌───────────────────────┐               ┌───────────────────────┐
│  SessionManager       │               │  SessionManager       │
│  ├── local sessions   │               │  ├── local sessions   │
│  └── resolver ────────┼── gRPC/HTTP ──┼→ resolver             │
│                       │               │                       │
│  ChannelService       │               │  ChannelService       │
│  └── FederationAdapter├── NATS/gRPC ──┤  FederationAdapter    │
│                       │               │                       │
│  FederationConnector  │               │  FederationConnector  │
│  └── peers: [gw-b]   ├── heartbeat ──┤  └── peers: [gw-a]   │
└───────────────────────┘               └───────────────────────┘
```

**From the agent's perspective, nothing changes.** A session on gw-a sends a
message to `gw-b/chat:main` via channels or spawn. The SessionManager sees the
`gw-b` prefix, delegates to the federation resolver, which proxies to gw-b.
The receiving session on gw-b sees a normal inbound message. Channels bridge
transparently via the federation adapter.

**From the plugin author's perspective:** implement `SessionResolver` (3 methods),
`ChannelAdapter` (2 methods), and a connector that wires them together. Discovery
(peer registry, heartbeats, whitelisting) is the plugin's problem — the framework
doesn't prescribe it.

#### Core Changes Required

| Change                         | Size      | Description                                             |
| ------------------------------ | --------- | ------------------------------------------------------- |
| `SessionAddress` type          | ~20 lines | Add optional `gateway` field, `parseSessionAddress()`   |
| `SessionResolver` interface    | ~15 lines | `canResolve()`, `send()`, `call()`                      |
| `SessionManager.setResolver()` | ~10 lines | Check for remote address before local create            |
| `ChannelService` tweak         | ~5 lines  | Ensure adapter source tagging prevents federation loops |

**~50 lines of core code.** Everything else — discovery, transport, auth,
heartbeats, peer management — is plugin territory.

#### Design Principles

1. **Local is default.** No gateway field = local. Zero overhead when federation
   isn't used. The resolver is optional — if none is registered, remote addresses
   fail with a clear error.

2. **Agents don't know.** A component doesn't care if its session is local or if
   it was reached via federation. Same hooks, same channels, same spawn. The
   routing is infrastructure, not application logic. (Same principle as multi-user
   scoping — the agent never sees it.)

3. **Discovery is plugin territory.** The framework provides the routing seam
   (SessionResolver). How you find peers — static config, DNS-SD, consul,
   hardcoded IPs, whatever — is up to the plugin. No opinion from the framework.

4. **Channels bridge, sessions proxy.** Channel events flow through the adapter
   (pub/sub bridging). Session operations (send, method calls) flow through the
   resolver (request/response proxying). Two patterns, clearly separated.

#### Open Questions

- **Latency.** Cross-gateway spawn() is a remote tool call. Could be slow.
  Should the framework expose this latency to the agent (timeout knob?) or
  hide it?
- **Consistency.** What happens if gw-b goes down mid-execution? The resolver
  gets an error, but what does the calling session see? AbortError? Retry?
- **Channel ordering.** Channel events bridged via NATS/gRPC may arrive
  out-of-order. Is that acceptable? (Probably — channels are already
  unordered pub/sub.)
- **Auth model.** Peer gateways need mutual authentication. mTLS? Shared
  secrets? OAuth? Plugin decides, but should there be a recommended pattern?
- **Session migration.** Can a session move from gw-a to gw-b? The virtual
  actor model (hibernate → hydrate anywhere) supports this if storage is
  shared. Federation makes it more interesting — the resolver could redirect
  after migration.

---

### Execution Environments: The REPL Model

> Insight from analyzing pi-coding-agent's extension system and the broader
> "malleable software" pattern. This reframes how sessions execute — the model
> is not the only consumer of the compiled tree. The execution environment is
> pluggable.

#### The Core Insight

Today, the compilation pipeline has one consumer:

```
Component Tree → Fiber Tree → COM → Model Adapter → LLM API
```

Tools become schemas. Sections become prompt text. Timeline becomes messages.
Everything compiles "for the model."

But the model isn't the only possible consumer. The compiled output — tools,
sections, state, timeline — is an **execution context**. Who evaluates input
against that context is pluggable:

```
Component Tree → Fiber Tree → COM → Execution Environment
                                      ├── Default: model calls tools via tool_use protocol
                                      └── REPL: model writes code, sandbox executes it
```

A `<Tool>` doesn't have to become a schema in a tools array. It can become a
callable function in a sandbox. A `<Section>` doesn't have to become prompt text.
It can become a data object. The component tree defines the context. The
environment decides how it's consumed.

#### Execution Environment Interface

The environment is a cohesive unit — not two loose functions, but an entity
with matched model/tool handling plus lifecycle hooks:

```typescript
const app = createApp(MyAgent, {
  environment: replEnvironment({
    extensionsDir: "~/.agentick/extensions",
    sandbox: { memoryLimit: 256, timeout: 30000 },
  }),
});
```

What an environment controls:

| Concern                     | What it does                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model input preparation** | Transforms compiled context before the LLM sees it. Default: pass tools as schemas. REPL: strip tools from schema, render as command descriptions in context, pass only `execute` tool. |
| **Tool call execution**     | Wraps how tool calls run. Default: route to handler by name. REPL: intercept `execute` calls, run code in sandbox where tools are callable functions, handle guards/confirmation.       |
| **Lifecycle hooks**         | `onSessionCreate`, `onSessionRestore`, `onSessionPersist` — the environment manages its own state (sandbox filesystem, extension dirs, REPL history).                                   |

The framework provides a default environment (today's behavior). The REPL
environment is an ecosystem package (`@agentick/repl`). Users can build custom
environments for other patterns (pipelines, human-in-the-loop, hybrid).

**The framework stays agnostic.** It doesn't know what "REPL" means. It calls
environment methods at the right points in the session lifecycle. The environment
decides what to do.

#### Tool Metadata

Tools carry environment-specific metadata. The framework passes it through
without interpreting it:

```typescript
const searchTool = createTool({
  name: "search",
  metadata: { executable: true },  // REPL env reads this; default env ignores it
  description: "Search the web",
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => { ... },
});
```

The REPL environment reads `metadata.executable` and moves those tools from the
model's tool array into the sandbox as callable functions. The default environment
ignores it. No `kind: "command"` baked into the framework — the metadata contract
is between the tool author and the environment they target.

#### The REPL Environment

Inspired by pi-coding-agent, which has only 4 system tools: `read`, `write`,
`update`, `bash`. Everything else is a command in the shell. Pi doesn't need
50 tools in a schema array because bash is the universal tool — you compose
operations in code.

The agentick REPL environment works the same way:

**What the model sees:**

```
<Section id="available-commands">
  search(query: string) — Search the web for information
  bash(command: string) — Execute a shell command
  define_command(name, code) — Define a new reusable command
  list_commands() — Show all available commands
  ...
</Section>

tools=[execute]    ← ONE tool
```

**What happens on tool call:**

```
Model: tool_use("execute", { code: "search('quantum computing')" })
  → REPL environment intercepts
  → Runs code in sandbox where search() is a real function
  → search handler executes (same handler as createTool defined)
  → Guards/confirmation checked by tool executor
  → Result returns to model
```

Tools become commands. The model composes them in code instead of making
individual tool calls. This solves the tool explosion problem — small tool
array, infinite capability via composition.

#### The Execute Tool + spawn() Pattern

**The context weight problem:** Every tick sends the full context — timeline,
sections, tools. For rapid iteration (run test, read error, fix, run test),
the model pays for the entire conversation on every tick. For 15 iterations,
that's 15x the full context.

**The solution: `execute` spawns a child session.**

```
Parent session (full conversation context):
  User: "Fix the failing auth tests"
  Model: "Let me fix those."
  → tool_use("execute", { task: "Fix failing tests in auth module" })

    Spawned child (REPL context — lightweight):
      System: "Fix failing tests in auth module"
      Commands: bash, read, write, update, search, [extensions]
      Tick 1:  bash("pytest tests/auth/")        → 3 failures
      Tick 2:  read("tests/auth/test_login.py")   → source
      Tick 3:  update("tests/auth/test_login.py")  → fixed
      Tick 4:  bash("pytest tests/auth/")          → 1 failure
      ...12 more ticks, fast, cheap context...
      Result: "Fixed 3 failures in auth module"

  ← result returns to parent timeline
  Model: "Fixed the 3 failing tests. Here's what changed: ..."
```

The child session has: the task + commands + recent results. No conversation
history. Iterates fast and cheap. The parent gets a summary.

Events from the child (each bash call, each file edit) stream out through
the session event system. The UI shows them in real-time. Tool confirmations
bubble up — if a command needs user approval, it propagates to the parent.

This is just spawn(). The `execute` tool is a spawn wrapper. The child session
uses the REPL environment. The parent session can use any environment.

#### Parent Context Access (All Spawns)

**Key insight: spawned agents should have access to parent context via a
command/tool.** Not by paying for the full context on every tick — by searching
it on demand.

```javascript
// In the spawned REPL child:
search_context("what did the user say about auth requirements?");
// → Searches parent's timeline, returns relevant messages

parent_context.timeline; // full parent timeline as queryable data
parent_context.state; // parent's comState values
```

The parent's compiled context is injected into the child as a searchable
variable or command. The child doesn't pay for it on every tick. But when it
needs background from the conversation, it reaches back.

**This applies to ALL spawns, not just REPL spawns.** Any child session could
have a `search_parent_context` tool. Independent of the execution environment.
This is a spawn() feature, not a REPL feature.

#### Filesystem-Backed Sandbox

Each session's REPL has a filesystem presence. Extensions, state, workspace —
all files.

**Per session:**

```
~/.agentick/sessions/{session-id}/
├── workspace/        # Working directory (or symlink to project root)
├── extensions/       # Session-local commands/functions
├── state.json        # REPL runtime state (defined variables, etc.)
└── history.jsonl     # Command execution history
```

**Per project (shared, checked into git):**

```
/path/to/project/.agentick/
├── extensions/       # Project-wide commands
├── config.ts         # Project agent config
└── sessions/         # Per-session state dirs
```

**Extension resolution (like $PATH):**

```
Session extensions → Project extensions → User extensions → Built-in commands
~/.agentick/sessions/{id}/ext/  →  .agentick/ext/  →  ~/.agentick/ext/  →  built-in
```

Session-local overrides project. Project overrides user. User overrides built-in.
`repl.promote("track_tokens")` copies a command up a level — from session-local
to project-wide, or project to user global.

#### Self-Extension

The agent creates commands the same way it does everything else: by writing
files. No plugin API. No extension registration. Just filesystem operations.

1. Agent uses `write` to create a file in the extensions dir
2. File contains a command definition (function, description, schema)
3. Next tick (or next session), the environment loads it
4. It's now a callable command
5. Agent can `read` it back, modify with `update`, delete it

**Defining a command at runtime (in the REPL sandbox):**

```javascript
define_command("track_tokens", {
  description: "Track token usage per bash command",
  handler: (cmd, result) => {
    const records = state.get("token_records") ?? [];
    records.push({ cmd, tokens: estimate(result), ts: Date.now() });
    state.set("token_records", records);
  },
});

// Save to disk for next session:
save_command("track_tokens");
// → writes to extensions dir, auto-loaded on restore
```

The `.vimrc` pattern: users curate their command directory over time. Some
commands they wrote. Some the agent wrote. Some from the community. The
directory IS the configuration.

#### Persistence Story

**Session persistence doesn't change.** Snapshots contain timeline, comState,
knobs, tick — conversation state. The default auto-persist/restore handles this.

**Filesystem state is parallel.** Extensions, REPL state, workspace files live
on disk. They persist naturally (they're files). On session restore, the
environment re-reads them.

**Distributed deployment:** The environment's lifecycle hooks handle this.
`onSessionPersist` bundles filesystem state into the snapshot (or a sidecar
store). `onSessionRestore` unpacks it on whatever machine the session lands on.
The session snapshot carries the conversation. The environment carries its own
state. Clean separation.

```typescript
// REPL environment lifecycle hooks (sketch):
{
  onSessionPersist(session, snapshot) {
    // Bundle extensions + REPL state into snapshot metadata
    // or save to object storage keyed by session ID
    return { ...snapshot, meta: { ...snapshot.meta, replState: bundled } };
  },

  onSessionRestore(session, snapshot) {
    // Unpack extensions + REPL state onto local filesystem
    // Session is now ready to execute with full REPL context
    unpack(snapshot.meta.replState, session.workingDir);
  },
}
```

#### Connection to Existing Architecture

| Concept            | How it fits                                                                      |
| ------------------ | -------------------------------------------------------------------------------- |
| **Component tree** | Unchanged. Defines tools, sections, state. The environment consumes differently. |
| **COM / Compiler** | Unchanged. Produces the same compiled output. Environment adapts it.             |
| **Session**        | Unchanged. REPL sessions are sessions. Same lifecycle, persistence, events.      |
| **spawn()**        | The `execute` tool IS spawn. Child session with REPL environment.                |
| **Persistence**    | Unchanged. Environment adds lifecycle hooks for its own filesystem state.        |
| **Middleware**     | Tool executor is middleware. Guards, confirmation, logging — all composable.     |
| **Events**         | Child session events stream to parent/UI. Already works.                         |
| **Knobs**          | Work in REPL mode. Model sets knobs via code: `set_knob("depth", "thorough")`.   |

#### What This Means for Agentick

The framework doesn't prescribe how sessions execute. It provides:

1. **A component model** for defining execution context (tools, state, sections)
2. **A compilation pipeline** that produces structured output
3. **A session primitive** with lifecycle, persistence, spawn, events
4. **A pluggable execution environment** that determines how the context is consumed

The default environment is what exists today — model calls tools via tool_use.
The REPL environment is an alternative — model writes code, sandbox executes.
Users can build any environment. The framework is ultimately flexible.

**This is the story of agentick:** not "a framework for building agents" but
"a framework for building any LLM execution environment." Agents, pipelines,
REPL-driven coding assistants, hybrid human-AI workflows — all compositions
of the same primitives with different environments.

#### Open Questions

- **Environment interface:** What exactly are the method signatures? How much
  does the environment control vs. the framework?
- **Sandbox technology:** vm.Module? isolated-vm? Deno subhosting? What gives
  the right security/performance tradeoff?
- **Hot reload:** When an extension file changes mid-session, does the next
  tick pick it up automatically? (Probably yes — component re-renders, scans dir.)
- **Extension format:** Plain JS functions? TypeScript with schemas? Markdown
  with frontmatter? The environment decides, but a convention helps.
- **Confirmation UX:** How do tool confirmations in a spawned REPL child
  surface to the user? Inline in the parent chat? Separate panel?
- **Token estimation:** In REPL mode, the model doesn't get structured tool
  results — it gets code execution output. How to estimate/control token usage?
- **Model compatibility:** REPL mode asks the model to write code. Some models
  are better at this than others. Is this a concern or a feature?
- **Spawned agent depth:** Can a REPL child spawn its own children? (Yes —
  sessions are self-similar. But resource limits matter.)
