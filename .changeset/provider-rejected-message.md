---
"@agentick/spec": minor
"@agentick/model-google": patch
---

Two fixes that together turned an invisible misconfiguration into a one-glance one.

**`ProviderRejected` carries its cause's message.** It was the only error in the
executor family that didn't — `StreamFailed`, `NormalizationFailed`,
`ProjectionFailed` and `UnknownExecutorError` all inline theirs — and it is the
wrapper the loop puts around a failed stream. So the informative message went in and
`"provider rejected"` came out, which was then the entire explanation reaching a
caller's `SendResult`, the turn-boundary record, every log line, and any UI. The
real sentence sat two levels down in `cause`, reachable only by a consumer that knew
to walk it — one fact, and every consumer needing its own walker.

`_tag` is unchanged and remains the classification and grep key; only the prose is
now useful. No prefix is added, because prefixing stacks
`"provider rejected: provider stream failed: …"` onto a chain that is already
nested. A cause with nothing to say still yields the bare `"provider rejected"`.

`causeMessage(cause)` is exported so future wrappers have one right way to do this.
Deliberately NOT applied in `AgentickError` itself: a `cause` may carry secrets,
which is why some subclasses redact it from `toJSON()`, and folding a cause into
`message` — always serialized — would defeat that. It is the wrapper's call, made
where the wrapper knows what its cause is.

**The Google adapter stops invalidating an explicit Vertex configuration.**
`buildClientOptions` read `GOOGLE_API_KEY` / `GEMINI_API_KEY` from the environment
into `apiKey`, then merged adopter `clientOptions` on top. `GoogleGenAI` treats
`project`/`location` and `apiKey` as mutually exclusive and throws when given both —
so an adopter who passed `{ vertexai: true, project, location }` and happened to
have `GOOGLE_API_KEY` set for unrelated reasons got both, and every execution died
in single-digit milliseconds with

    Project/location and API key are mutually exclusive in the client initializer.

They had configured Vertex correctly; the framework added the field that broke it. A
fallback must never be able to invalidate an explicit choice, so the env key is now
suppressed whenever `vertexai`, `project` or `location` is supplied — keyed on the
same fields the SDK's own exclusivity check uses, so a bare `project` counts.

Two things it deliberately does NOT do: it does not arbitrate between two EXPLICIT
instructions (an adopter passing both an `apiKey` and Vertex fields still gets the
SDK's error, because silently discarding one of two things they asked for is how
this bug class starts), and it does not suppress the unrelated
`GOOGLE_GENAI_BASE_URL` fallback, which conflicts with nothing.
