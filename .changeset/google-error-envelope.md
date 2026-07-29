---
"@agentick/spec": minor
"@agentick/model-google": minor
---

The Google adapter takes the `mapProviderError` seam, so a rejection reads as a
sentence instead of an envelope.

`LanguageModelAdapter.mapProviderError` is documented as "override when your provider
surfaces structured errors you can extract more detail from". Google surfaces them;
this adapter never took the hook. `GoogleGenAI` puts a SERIALIZED envelope in
`Error.message`, and that envelope's own `error.message` is frequently another
serialized envelope — so a bad request reached the caller's `SendResult`, the durable
turn boundary, and any UI as ~250 characters of escaped JSON:

    {"error":{"message":"{\n  \"error\": {\n    \"code\": 400,\n    \"message\":
    \"Request contains an invalid argument.\",\n    \"status\":
    \"INVALID_ARGUMENT\"\n  }\n}\n","code":400,"status":"Bad Request"}}

`mapProviderError` now peels it: descend through `error`, and if the `message` found is
itself parseable JSON, descend again. The DEEPEST message wins, because the outer
layers are transport restatements ("Bad Request") while the inner one is the provider's
actual complaint. `status` is appended because the sentence usually omits the failure
CLASS — "Request contains an invalid argument." does not say which argument, and
`INVALID_ARGUMENT` is the searchable half. The unwrap is depth-bounded rather than a
`while (true)`, so a malformed or hostile payload cannot spin.

The above becomes:

    Request contains an invalid argument. [INVALID_ARGUMENT] (status=400)

A failure with nothing structured to extract stays a `StreamFailed` rather than being
dressed as a provider rejection — a socket hangup is not the model refusing.

`ProviderRejected` gains an optional `message`, taking precedence over the cause's own
words, which is how an adapter that knows its provider's envelope supplies the
extracted sentence. The raw envelope stays on `cause`, so nothing is lost — only
unburied.
