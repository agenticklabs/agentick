/**
 * The group-prose wire (`_meta["agentick/toolGroups"]` on a `tools/list`
 * RESULT) — parsed leniently: prose is decoration, so a malformed manifest
 * entry is dropped rather than costing the tools that carried it.
 */
import { describe, expect, it } from "vitest";

import { toolGroupManifest } from "../with-mcp.js";

describe("toolGroupManifest", () => {
  it("parses a well-formed manifest, order included", () => {
    const groups = toolGroupManifest({
      "agentick/toolGroups": [
        {
          path: ["knowify-write", "service"],
          title: "Service work",
          summary: "Tickets and visits.",
          order: 3,
        },
      ],
    });
    expect(groups).toEqual([
      {
        path: ["knowify-write", "service"],
        title: "Service work",
        summary: "Tickets and visits.",
        order: 3,
      },
    ]);
  });

  it("accepts a bare-string path as one segment — the `agentick/group` leniency, shared", () => {
    const groups = toolGroupManifest({
      "agentick/toolGroups": [{ path: "memory", title: "Memory", summary: "…" }],
    });
    expect(groups[0]!.path).toEqual(["memory"]);
  });

  it("drops malformed entries and keeps the rest", () => {
    const groups = toolGroupManifest({
      "agentick/toolGroups": [
        { path: ["ok"], title: "OK", summary: "kept" },
        { path: [42], title: "bad", summary: "dropped" },
        { path: ["no-title"], summary: "dropped" },
        null,
        "garbage",
      ],
    });
    expect(groups.map((g) => g.title)).toEqual(["OK"]);
  });

  it("answers [] for an absent, non-array, or metadata-free result", () => {
    expect(toolGroupManifest(undefined)).toEqual([]);
    expect(toolGroupManifest({})).toEqual([]);
    expect(toolGroupManifest({ "agentick/toolGroups": "nope" })).toEqual([]);
  });
});
