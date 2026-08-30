# @agentick/credentials

**Your software already has authentication. This is how an agent borrows it —
without the secret ever reaching the model, the journal, or the wire.**

You are adding an agent to a system that already knows who its users are and
already has a way to call its own APIs on their behalf. You do not need to move
your secrets, adopt a vault, or change how you issue tokens. You need two
things: a way to tell agentick **who is acting**, and a way for your code to get
**the credential that identity acts with**, at the moment it makes a call.

```bash
npm install @agentick/credentials
```

## The two questions

Every request into your agent answers two separate questions, and keeping them
separate is the whole design.

|                        | **who is acting**         | **what they act with**        |
| ---------------------- | ------------------------- | ----------------------------- |
| you implement          | `AuthSource`              | a credential provider         |
| produces               | an identity, a principal  | a token, a key, a session id  |
| written to the journal | **yes** — every operation | **never**                     |
| lives                  | on the operation's scope  | in your store, read on demand |

The journal is agentick's durable record of everything an agent did. An identity
belongs there — you want to know _who_ an agent acted as, months later. A bearer
token does not: writing one to durable storage on every operation is a
credential on disk forever, replayable for as long as it lives.

That single rule is why there are two mechanisms instead of one.

## The five-minute version

**1. Tell agentick who is acting.** You already have this logic — it is whatever
your app does with a session cookie or an `Authorization` header today.

```ts
const authSource: AuthSource = {
  backend: "acme-sso",
  async authenticate(credential) {
    const claims = await verifyYourToken(credential.token);
    return { principal: `${claims.tenant}:${claims.user}`, scopes: claims.scopes };
  },
};
```

`principal` is the string agentick attributes sessions and operations to. Use
whatever your system already considers a user's stable id.

**2. Point a provider at where your credentials already live.** You are not
migrating anything. If your API tokens are in Redis, read Redis:

```ts
import { defineCredentialProvider } from "@agentick/credentials";

const acmeTokens = defineCredentialProvider({
  namespace: "acme",
  backend: "redis",
  // `key` is yours to choose. The principal is a natural one.
  get: (key, ctx) => redis.get(`token:${key}`),
});
```

**3. Register it.**

```ts
const gateway = await createGateway({ credentials: [acmeTokens] });
```

**4. Use it where you make the call.**

```ts
async function sendInvoice(invoiceId: string, principal: string) {
  const token = await bridges.credentials.get<string>("acme", principal);
  return fetch(`${API}/invoices/${invoiceId}/send`, { headers: { Authorization: token } });
}
```

That is the whole integration. Your auth stays where it is; agentick learns to
ask for it.

## The part people get wrong

**Tools never see credentials.** There is no `ctx.credentials` on a tool
handler, and that omission is deliberate.

The thing deciding which tool to call is a language model reading untrusted
input — a web page, an email, a customer's message. If a tool could read a
token, then any tool call the model can be talked into is a token disclosure.
This is the confused-deputy problem, and it is why the credentials bridge is
reachable from **your** code and not from the model's.

So the shape is: **your code binds a service that holds the authority; the tool
calls that service.**

```ts
// Your host code — has credentials, has the principal.
const invoices = {
  send: (invoiceId: string, principal: string) => sendInvoice(invoiceId, principal),
};

// The tool — calls a function. Never sees, and cannot ask for, a token.
createTool({
  name: "send_invoice",
  handler: async ({ invoice_id }, { ctx }) => {
    await invoices.send(invoice_id, ctx.principal!);
    return "Sent.";
  },
});
```

A prompt-injected tool call can still _send an invoice it should not have_ —
that is what confirmations and guards are for — but it cannot walk away with the
credential.

## Store or mint — the same interface

`get` is a **resolution** verb, not a lookup. It may read something stored, or
create something on demand. Callers cannot tell, and should not need to.

```ts
// Reads what another service wrote.
defineCredentialProvider({
  namespace: "acme",
  backend: "redis",
  get: (principal) => redis.get(`token:${principal}`),
});

// Mints per call. Nothing is stored at all.
defineCredentialProvider({
  namespace: "acme-impersonation",
  backend: "sts",
  get: (principal) => yourAuthService.issueScopedToken({ actAs: principal, ttl: 300 }),
});
```

The second shape is worth reaching for. A short-lived token minted per use has a
blast radius measured in minutes; a stored long-lived one has a blast radius
measured in its lifetime. If your system can issue on demand — and most systems
with an internal auth service can — do that and store nothing.

`get` is the only required method. A minter has nothing to `set` and no
meaningful `keys`, so it omits them, and the harness reports an unsupported
operation rather than a silent no-op.

## One namespace, one owner

A namespace selects exactly one provider. Registration is exact-match, with no
fallback chain:

```ts
createGateway({
  credentials: [
    acmeTokens, // namespace: "acme"
    stripeKeys, // namespace: "stripe"
    githubOAuth, // namespace: "github"
  ],
});
```

- `get("acme", …)` routes to `acmeTokens`.
- `get("typo", …)` throws `UnknownCredentialNamespace` — it does **not** return
  `undefined`. A namespace nobody wired is a composition bug; a key that is
  simply absent is `undefined`, which is a real answer.
- Registering a second provider for `"acme"` throws
  `DuplicateCredentialNamespace`. Silently shadowing a credential source is a
  security event, not a convenience.

The harness always exists, even with nothing configured, and ships one provider:
an in-memory store under `ephemeral`. It is named for its lifetime — it dies with
the process — so nothing about the name suggests your credentials will survive a
restart. Nothing in the framework ever writes to it.

## Multi-tenant: the provider is the boundary

A namespace is a naming scheme, not an isolation boundary. The isolation is that
**your provider is told who is asking**:

```ts
defineCredentialProvider({
  namespace: "acme",
  backend: "redis",
  get: (key, ctx) => {
    // ctx.principal is the identity this work is running as.
    if (key !== ctx.principal) return undefined; // no cross-tenant reads
    return redis.get(`token:${key}`);
  },
});
```

`ctx` is a `StoreCtx`, which extends the runtime context — so it carries
`principal`, `sessionId`, and the operation's own id. If you serve more than one
tenant, check it. Nothing enforces this for you, because only you know what your
tenancy rules are.

## What ends up in the journal

Writes are journaled operations, so a guard can veto one and an audit hook can
observe it — but the record is the **address**, never the value:

```
credentials:command:set   { namespace: "acme", key: "8580:32728" }
```

There is no redaction pass to misconfigure, because the value was never in the
operation's input. Reads are not operations at all; they are data-plane calls
that never touch the bus.

## Bringing your own backend

Anything with an async read works — Vault, AWS Secrets Manager, 1Password, your
own service, a file. Two bundled providers cover the common cases:

```ts
import { envCredentialProvider, inMemoryCredentialProvider } from "@agentick/credentials";

envCredentialProvider({ namespace: "acme" }); // AGENTICK_CRED_ACME_<KEY>, read-only
inMemoryCredentialProvider({ namespace: "test" });
```

The `env` provider is the zero-config path: it keeps today's environment-variable
habit while putting the lookup behind the seam, so pointing at a real secret
manager later is a one-line change with no caller edits.

Prove your own provider behaves:

```ts
import { runCredentialProviderConformance } from "@agentick/credentials/testing";

runCredentialProviderConformance({
  label: "acmeTokens",
  factory: () => acmeTokens,
  capabilities: { writable: false, enumerable: false },
});
```

Declare what your provider supports; the suite checks the omissions are honest —
an absent `set` must be genuinely absent, not one that quietly does nothing.

## API

|                                             |                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `defineCredentialProvider(spec)`            | Validate and freeze a provider. Requires `namespace`, `backend`, `get`. |
| `bridges.credentials.get(ns, key)`          | Resolve. `undefined` when absent; throws on an unknown namespace.       |
| `.set(ns, key, value)` / `.delete(ns, key)` | Journaled write operations.                                             |
| `.has(ns, key)` / `.keys(ns)`               | Presence and enumeration, where the provider supports them.             |
| `.register(p)` / `.unregister(ns)`          | Registry changes at runtime.                                            |
| `.start(ns)` / `.stop(ns)`                  | Acquire and release whatever backs a provider.                          |
| `.subscribe(fn)`                            | `{ namespace, key }` on every change. Never the value.                  |

## Design notes

- **Server-resident, always.** Credentials never cross the wire. A UI drives
  credential lifecycle by sending verbs (`reauthenticate()`, `disconnect()`) that
  your server resolves — never by fetching a token.
- **No inbox protocol.** The harness deliberately accepts no messages. An inbox
  verb would be a network-reachable secret read.
- **The framework stores nothing and expires nothing.** It defines an interface,
  routes to your implementation, and records that a resolution happened. Caching,
  rotation, and lifetime are yours — if your provider is expensive, memoize it.

See ADR 107 for the reasoning, including the prior art (Vault's mounted secret
engines, Airflow's pluggable backends, Temporal's refusal to own credentials at
all) and the alternatives that were rejected.
