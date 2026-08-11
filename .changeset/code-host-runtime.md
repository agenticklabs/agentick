---
"@agentick/code-host": minor
---

`@agentick/code-host` — the first real `Runtime` for `@agentick/code`, and the
proof that the language-neutral conformance suite certifies a language-having
provider. `hostRuntime()` spawns `process.execPath`: whatever JS engine runs the
host app is the engine that runs model-authored code, so the trust decision an
adopter already made about their own runtime is the one that applies, with no
second engine to vet or install.

Engine differences surface as CAPABILITY differences rather than as separate
packages. `timeMs` (a parent-side kill) and `outputBytes` (a parent-side cut)
hold whatever the child is, so both are always declared. `memoryMb` needs the
engine's own heap ceiling, and only node has one that works: bun accepts
`--max-old-space-size` AND `--smol`, exits zero on both and enforces neither —
an allocation loop outlives a 3s watch at every setting where node dies in
~100ms — so `host:bun` leaves `memoryMb` out of `enforces` and the harness
refuses it up front instead of handing back a ceiling that does nothing. The
measurement is a test, not a docblock.

One child process per context, which is what `persistentContext: true` means
here: `globalThis`, timers and imports carry across executions on one context,
two contexts never share a process, and a child that dies takes its context with
it (`CodeRuntimeFailed` on the next `execute`) rather than quietly starting a
fresh one that would answer with an empty world. Programs are async function
BODIES — `return` answers, top-level await is ordinary, bindings are ambient
names.

The control channel is ndjson on a dedicated file descriptor, so the program's
own stdout and stderr stay fds 1 and 2: a program printing a forged result frame
is captured as output and cannot answer for itself. Bindings run in the host
process and are marshaled across as JSON — the child rebuilds the caller's
context tree with a proxy at each function's dotted path and freezes every
namespace — with binding rejections raising inside the program (catchable) and a
return value that cannot be marshaled rejecting as a membrane failure rather
than being reported as a program that threw.

Placement is a seam, not a setting: `HostProcessPort` is the entire surface the
runtime needs to have a child — spawn, write, kill — with `childProcessPort()`
as the default. This is deliberately NOT containment; the child is an ordinary
process of the same user, and pairing the port with a real sandbox is roadmap,
stated plainly in the README rather than implied away.

`@agentick/code-host/testing` ships `hostCodeSource` / `hostCodeProbe` so a layer
built on top certifies itself with the same programs this provider is certified
with.
