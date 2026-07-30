/**
 * `defineCompletion` — the SINGULAR of the file grammar: one named source per
 * file, folded into `defineCompletions({ sources: [...] })` by a barrel.
 *
 * What matters here: the named source stays a plain resolver (dual-use), the
 * builder metadata survives the naming, and the array fold refuses duplicates
 * at define time instead of last-wins at install.
 */
import { describe, expect, it } from "vitest";

import { completeDependent, completeFromList, isDependentResolver } from "../builders.js";
import {
  defineCompletion,
  defineCompletions,
  isNamedCompletionResolver,
  sourcesMapOf,
} from "../definition.js";
import { fakeCompletionCtx } from "../testing/index.js";

describe("defineCompletion", () => {
  it("names a resolver without ceasing to be one", async () => {
    const jobs = defineCompletion("knowify.jobs", completeFromList(["Miller", "Mercer"]));

    expect(isNamedCompletionResolver(jobs)).toBe(true);
    expect(jobs.completionName).toBe("knowify.jobs");
    // Dual-use: the named source is directly callable as a resolver.
    expect(await jobs("Mi", fakeCompletionCtx())).toEqual({ values: ["Miller"] });
  });

  it("keeps the name out of enumeration", () => {
    const jobs = defineCompletion("knowify.jobs", completeFromList(["Miller"]));
    expect(Object.keys(jobs)).toEqual([]);
    expect(JSON.stringify({ jobs })).not.toContain("knowify.jobs");
  });

  it("carries a dependent resolver's requires across the naming", async () => {
    const phases = defineCompletion(
      "knowify.phases",
      completeDependent({ requires: ["job"] }, (_v, { job }) => [`${job}: Framing`]),
    );

    expect(isDependentResolver(phases)).toBe(true);
    expect(isDependentResolver(phases) && phases.requires).toEqual(["job"]);
    // The gating still runs through the forwarding wrapper.
    expect(await phases("", fakeCompletionCtx())).toEqual({ values: [] });
    expect(await phases("", fakeCompletionCtx({ resolvedArguments: { job: "Miller" } }))).toEqual({
      values: ["Miller: Framing"],
    });
  });

  it("wraps rather than mutates — one resolver may be named twice", () => {
    const base = completeFromList(["x"]);
    const a = defineCompletion("a", base);
    const b = defineCompletion("b", base);
    expect(a.completionName).toBe("a");
    expect(b.completionName).toBe("b");
    expect(isNamedCompletionResolver(base)).toBe(false);
  });
});

describe("defineCompletions — the sources seam", () => {
  it("folds a barrel of named sources into the registry map", () => {
    const sources = [
      defineCompletion("knowify.jobs", completeFromList(["Miller"])),
      defineCompletion("knowify.phases", completeFromList(["Framing"])),
    ];
    defineCompletions({ sources }); // define-time validation passes
    expect(Object.keys(sourcesMapOf(sources)).sort()).toEqual(["knowify.jobs", "knowify.phases"]);
  });

  it("throws on a duplicate name at define time", () => {
    const dup = () =>
      defineCompletions({
        sources: [
          defineCompletion("knowify.jobs", completeFromList(["a"])),
          defineCompletion("knowify.jobs", completeFromList(["b"])),
        ],
      });
    expect(dup).toThrowError(/duplicate completion name "knowify\.jobs"/);
  });
});
