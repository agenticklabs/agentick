/**
 * ANTI-ROT: a harness never decides its own `EventScope.sessionId`.
 *
 * `scopeId` — a harness's first constructor argument — is its WORK identity, and for
 * a session sub-harness it is a COMPOSED key: `<sessionId>:timeline`. It has to stay
 * composed, because it is the inbox address root (`<surface>:<scopeId>`) and the
 * backing store key; two harnesses on one session would collide without the suffix.
 *
 * `EventScope.sessionId` answers a different question — which session did this happen
 * in — and the gateway narrows a `{ kind: "session", id }` subscription to
 * `scope.sessionId === id`. So the two are NOT interchangeable, and confusing them is
 * invisible until something tries to SUBSCRIBE.
 *
 * Which is exactly what happened. While stamping was each harness's own job, SIX
 * session sub-harnesses wrote `sessionId: this.scopeId` — timeline, knobs, state,
 * resources, prompts, skills, gates — and the declaration seam's own docstring
 * offered `() => ({ sessionId: this.scopeId })` as the example to copy. Nothing
 * matched. Nothing errored: each subscription opened, matched nothing, and stayed
 * open. Every client-side live projection over those surfaces was silently dead —
 * timeline tails, knob state, task status — and the symptom that finally surfaced it
 * was a chat panel showing a user's message followed by nothing at all.
 *
 * Two harnesses had been given an ad-hoc `parentScope` option to work around it. Four
 * had not. The fix is one axis on `BaseHarness`, folded into the resolved op scope
 * once, so a harness that declares nothing still emits attributable events.
 *
 * This file is the enforcement: a grep that fails on the pattern's return. It is a
 * text sweep rather than a behavioural one on purpose — it has to catch a NEW harness
 * written next year by someone who never read any of this, including one nobody
 * remembered to add to a bridge bundle.
 *
 * @see packages/transport-in-process/src/__tests__/timeline-live-tail-e2e.spec.ts
 *   — the behavioural half: a real gateway, a real client, a window that grows.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/**
 * The banned expression. Any spelling of "use my own work identity as the session
 * coordinate" — the exact substitution that made six harnesses unsubscribable.
 */
const BANNED = /sessionId:\s*this\.scopeId/;

/**
 * The one escape hatch, named for exactly what it asserts.
 *
 * `sessionId` is an overloaded field name, and in two other places the COMPOSED
 * `scopeId` is the correct value:
 *
 *   - **`StoreCtx.sessionId` is a store KEY.** A hydrator reads
 *     `store.read(ctx.sessionId ?? "", ctx)` against a log keyed by `scopeId`.
 *   - **Data payloads** — `MediaSessionRef`, a tool call's `context` — name the
 *     session of a harness whose `scopeId` IS its session.
 *
 * Both are the same disease one layer down: one field name carrying two concepts
 * (tracked as `TODO(store-ctx-key-name)`). Until those are renamed, an explicit
 * opt-out beats a heuristic — a reviewer writing this marker has to state that the
 * value is not an event scope, which is the claim under review.
 */
const NOT_A_SCOPE_MARKER = "NOT AN EVENT SCOPE";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every `.ts` under a package's `src`, excluding tests and build output. */
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "__tests__") {
        continue;
      }
      yield* sourceFiles(path);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".spec.tsx")) continue;
      yield path;
    }
  }
}

function scan(): { readonly findings: readonly Finding[]; readonly filesScanned: number } {
  const findings: Finding[] = [];
  let filesScanned = 0;
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, "src");
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    for (const file of sourceFiles(src)) {
      filesScanned += 1;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        if (!BANNED.test(text)) return;
        // A comment ABOUT the pattern (this file is full of them) is not the pattern.
        if (text.trimStart().startsWith("//") || text.trimStart().startsWith("*")) return;
        // The documented non-scope exception, marked within the preceding few lines.
        const preamble = lines.slice(Math.max(0, index - 8), index).join("\n");
        if (preamble.includes(NOT_A_SCOPE_MARKER)) return;
        findings.push({
          file: file.slice(PACKAGES.length + 1),
          line: index + 1,
          text: text.trim(),
        });
      });
    }
  }
  return { findings, filesScanned };
}

describe("EventScope.sessionId has exactly one authority", () => {
  it("no harness stamps its own scopeId as the session coordinate", () => {
    // Named, not counted: a failure has to say which line to delete. The fix is
    // always the same — remove the stamp and declare `parentScope` at construction.
    expect(scan().findings.map((f) => `${f.file}:${f.line}  ${f.text}`)).toEqual([]);
  });

  it("the sweep is non-vacuous — it read the real source tree", () => {
    // A refactor that moved every harness, or a path assumption that quietly stopped
    // resolving, would make the check above pass by looking at nothing.
    expect(scan().filesScanned).toBeGreaterThan(200);
  });

  it("still catches the pattern — the regex is not dead", () => {
    // The guard on the guard. Asserted against literal text rather than a fixture
    // file, so it cannot rot with the tree layout.
    expect(BANNED.test("      scope: () => ({ sessionId: this.scopeId }),")).toBe(true);
    expect(BANNED.test("    const scope = () => ({ sessionId: this.scopeId });")).toBe(true);
    expect(BANNED.test("      { sessionId: this.scopeId, op: 'X' },")).toBe(true);
    // …and does not fire on the legitimate neighbours.
    expect(BANNED.test("      parentScope: { sessionId: store.id },")).toBe(false);
    expect(BANNED.test("      { sessionId: this.sessionId },")).toBe(false);
  });
});
