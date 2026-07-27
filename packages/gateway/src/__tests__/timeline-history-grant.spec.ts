/**
 * `timeline/history` at the GRANT tier — the worked example behind the gateway
 * README's "grant a client read" recipe (ADR 93 §"The client read doors").
 *
 * A read reaching the wire is TWO independent admissions, and this file pins both
 * against the bundled `staticAuthorizer`:
 *
 *   1. EXPOSURE (the harness author's curation) — the dynamic lane asks the
 *      surface what it declares. A verb that is not `exposure: "wire"` is
 *      indistinguishable from an absent method: `MethodNotFound`, never
 *      `Forbidden`. So `timeline/history` resolves and `timeline/append` does not,
 *      even for a caller holding `*`.
 *   2. GRANT (the deployment's policy) — the exposed verb's scope label is the
 *      canonical verb, `timeline:history`. `timeline:*` covers it; a narrower
 *      grant written for compaction does NOT. Nothing is readable by default.
 *
 * Plus the ADR-48 target rule, verified at the authorizer: a caller may hold `*`
 * and still be denied another principal's session. (Its end-to-end proof — that
 * the STAMPED session principal reaches the gate — is the in-process e2e; here it
 * is the policy unit.)
 *
 * The lane's `handler` is deliberately exposure-only: authorization happens once,
 * at the dispatch choke point (ADR 51 §3.3, `authorizeDispatch`), for the
 * porcelain and dynamic lanes alike. So the grant assertions below drive the
 * authorizer with the labels that choke point derives.
 */

import { describe, expect, it } from "vitest";

import { ErrorCode, WireRpcError, scopeCovers, type CommandInfo } from "@agentick/spec";
import { stubInbox, type StubInboxCall } from "@agentick/runtime/testing";

import { staticAuthorizer } from "../authorizers.js";
import { createCommandsListHandler, createDynamicCommandResolver } from "../dynamic-commands.js";

const TIMELINE_ADDR = "timeline:s1:timeline";

/** What `@agentick/timeline` declares — the READ is wire, the writes are not. */
const TIMELINE_COMMANDS: readonly CommandInfo[] = [
  { name: "timeline:history", exposure: "wire", hasInput: true },
  { name: "timeline:compact", exposure: "wire", hasInput: true },
  { name: "timeline:append", exposure: "addressable", hasInput: true },
  { name: "timeline:commands", exposure: "wire", hasInput: false },
];

const PAGE = { entries: [{ seq: 0, entry: { kind: "message" } }] };

function lane(grants: Record<string, readonly string[]> = {}) {
  const { inbox, asks } = stubInbox({
    fallback: (call: StubInboxCall) => {
      if (call.type === "timeline:commands") return { commands: TIMELINE_COMMANDS };
      if (call.type === "timeline:history") return PAGE;
      throw new Error(`unexpected ask: ${call.type}`);
    },
  });
  const authorizer = staticAuthorizer({ grants });
  return {
    authorizer,
    asks,
    inbox,
    resolver: createDynamicCommandResolver({ inbox, authorizer }),
  };
}

describe("timeline/history — exposure (deny-by-default)", () => {
  it("resolves the declared read and dispatches it with origin 'wire'", async () => {
    const { resolver, asks } = lane({ alice: ["timeline:*"] });

    const page = await resolver("timeline/history")!.handler(
      { sessionId: "s1", fromSeq: 4, limit: 25 },
      { principal: "alice" },
    );
    expect(page).toEqual(PAGE);

    const dispatch = asks.find((a) => a.type === "timeline:history")!;
    expect(dispatch.address).toBe(TIMELINE_ADDR);
    expect(dispatch.origin).toBe("wire");
    // The whole params bag rides as the payload; the harness's own schema
    // normalizes it (the addressing key never steers the read).
    expect(dispatch.payload).toMatchObject({ fromSeq: 4, limit: 25 });
  });

  it("an undeclared / non-wire timeline verb is MethodNotFound even for a `*` holder", async () => {
    const { resolver } = lane({ root: ["*"] });
    const codes = await Promise.all(
      ["timeline/append", "timeline/history_all"].map(async (method) => {
        const err = await resolver(method)!
          .handler({ sessionId: "s1" }, { principal: "root" })
          .catch((e: unknown) => e);
        return [method, err instanceof WireRpcError ? err.code : err] as const;
      }),
    );
    expect(codes).toEqual([
      ["timeline/append", ErrorCode.MethodNotFound],
      ["timeline/history_all", ErrorCode.MethodNotFound],
    ]);
  });

  it("commands/list advertises the read to a caller who can see the surface", async () => {
    const { inbox, authorizer } = lane({ alice: ["timeline:*"] });
    const reply = (await createCommandsListHandler({ inbox, authorizer })(
      { sessionId: "s1" },
      { principal: "alice" },
    )) as { commands: Array<{ method: string }> };
    const methods = reply.commands.map((c) => c.method);
    expect(methods).toContain("timeline/history");
    expect(methods).not.toContain("timeline/append"); // addressable ≠ wire
  });
});

describe("timeline/history — the grant (nothing is readable by default)", () => {
  const scope = "timeline:history";

  it("requires a grant covering `timeline:history`", async () => {
    const { authorizer } = lane({
      reader: ["timeline:history"], // the exact read grant — the recipe
      operator: ["timeline:*"], // the surface glob — reads + writes
      compactor: ["timeline:compact"], // written for compaction only
      root: ["*"],
    });

    const allowed = await Promise.all(
      ["reader", "operator", "root"].map(async (principal) => [
        principal,
        (await authorizer.authorize({ principal, scope })).allowed,
      ]),
    );
    expect(allowed).toEqual([
      ["reader", true],
      ["operator", true],
      ["root", true],
    ]);
    // A grant for a sibling verb does NOT leak the read.
    const denied = await authorizer.authorize({ principal: "compactor", scope });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("no-grant");
  });

  it("denies an ungranted principal and an anonymous caller alike", async () => {
    const { authorizer } = lane({ reader: ["timeline:history"] });
    expect((await authorizer.authorize({ principal: "mallory", scope })).allowed).toBe(false);
    // No `anonymous` grants configured → the unauthenticated pole reads nothing.
    expect((await authorizer.authorize({ scope })).allowed).toBe(false);
  });

  it("the read grant does NOT confer the write verbs", async () => {
    const { authorizer } = lane({ reader: ["timeline:history"] });
    for (const write of ["timeline:compact", "timeline:append"]) {
      expect((await authorizer.authorize({ principal: "reader", scope: write })).allowed).toBe(
        false,
      );
    }
  });

  it("the scope label is the canonical verb — one grant covers both lanes", () => {
    // `authorizeDispatch` derives the label from the method (`a/b` → `a:b`), so a
    // porcelain alias could never relabel its way past the verb's own grant.
    expect(scopeCovers("timeline:*", scope)).toBe(true);
    expect(scopeCovers("timeline:compact", scope)).toBe(false);
    expect(scopeCovers("*", scope)).toBe(true);
  });

  it("a `*` grant still loses to the same-principal target rule (ADR 48)", async () => {
    const { authorizer } = lane({ alice: ["*"], bob: ["*"] });
    const target = { sessionId: "s-bob", principal: "bob" };

    const cross = await authorizer.authorize({ principal: "alice", scope, target });
    expect(cross.allowed).toBe(false);
    expect(cross.reason).toBe("target-principal-mismatch");

    // Control — the owner reads their own session.
    expect((await authorizer.authorize({ principal: "bob", scope, target })).allowed).toBe(true);
  });
});
