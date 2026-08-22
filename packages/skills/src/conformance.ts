/**
 * Conformance suite for {@link SkillsHarnessProtocol} implementations.
 *
 * Validates the contract every skills backend must satisfy:
 *   - Sync surface: get / has / list / search / subscribe / subscribeAll
 *   - Async surface: register / update / remove
 *   - list() returns a stable reference between mutations; fresh after
 *   - subscribe fires per-name; subscribeAll fires on any mutation
 *   - register rejects duplicate names with `SkillAlreadyExists`
 *   - update rejects unknown names with `SkillNotFound`
 *   - remove is idempotent (no error on unknown name)
 *   - search filters by query substring + tagsAny + tagsAll
 *
 * Alternative impls (sqlite-backed, `agentskills.io` remote registry,
 * test stub) opt into this suite to prove they satisfy the protocol.
 */

import { describe, expect, it } from "vitest";
import type { SkillsHarnessProtocol } from "@agentick/spec";
import { SkillAlreadyExists, SkillNotFound } from "@agentick/spec";

export interface SkillsHarnessFactoryDeps {
  readonly make: () => Promise<SkillsHarnessProtocol>;
}

export function runSkillsHarnessConformance(deps: SkillsHarnessFactoryDeps): void {
  describe("SkillsHarness — sync surface", () => {
    it("get() returns undefined for unknown names", async () => {
      const h = await deps.make();
      expect(h.get("unknown")).toBeUndefined();
      await h.close();
    });

    it("has() reflects registration", async () => {
      const h = await deps.make();
      expect(h.has("git_push")).toBe(false);
      await h.register({
        name: "git_push",
        description: "Push the current branch to origin",
        content: "git push -u origin HEAD",
      });
      expect(h.has("git_push")).toBe(true);
      await h.close();
    });

    it("list() returns the same reference between mutations", async () => {
      const h = await deps.make();
      await h.register({ name: "a", description: "A", content: "..." });
      const a = h.list();
      const b = h.list();
      expect(a).toBe(b);
      await h.close();
    });

    it("list() returns a fresh reference after a mutation", async () => {
      const h = await deps.make();
      const before = h.list();
      await h.register({ name: "a", description: "A", content: "..." });
      expect(h.list()).not.toBe(before);
      await h.close();
    });

    it("list() is sorted by name", async () => {
      const h = await deps.make();
      await h.register({ name: "zeta", description: "Z", content: "..." });
      await h.register({ name: "alpha", description: "A", content: "..." });
      await h.register({ name: "mu", description: "M", content: "..." });
      expect(h.list().map((s) => s.name)).toEqual(["alpha", "mu", "zeta"]);
      await h.close();
    });
  });

  describe("SkillsHarness — async surface", () => {
    it("register() + get() round-trip with createdAt / updatedAt", async () => {
      const h = await deps.make();
      const registered = await h.register({
        name: "ssh_to_host",
        description: "SSH to a remote host with current creds",
        content: "ssh user@host",
        tags: ["ssh", "network"],
      });
      expect(registered.name).toBe("ssh_to_host");
      expect(registered.tags).toEqual(["ssh", "network"]);
      expect(registered.createdAt).toBeGreaterThan(0);
      expect(registered.updatedAt).toBe(registered.createdAt);

      const fetched = h.get("ssh_to_host");
      expect(fetched).toEqual(registered);
      await h.close();
    });

    it("register() rejects duplicate names with SkillAlreadyExists", async () => {
      const h = await deps.make();
      await h.register({ name: "dup", description: "first", content: "..." });
      await expect(
        h.register({ name: "dup", description: "second", content: "..." }),
      ).rejects.toBeInstanceOf(SkillAlreadyExists);
      await h.close();
    });

    it("update() merges fields and bumps updatedAt", async () => {
      const h = await deps.make();
      const a = await h.register({
        name: "task",
        description: "old",
        content: "old body",
        tags: ["a"],
      });
      await new Promise((r) => setTimeout(r, 5));
      const b = await h.update({
        name: "task",
        description: "new",
        tags: ["a", "b"],
      });
      expect(b.description).toBe("new");
      expect(b.content).toBe("old body"); // unchanged
      expect(b.tags).toEqual(["a", "b"]);
      expect(b.createdAt).toBe(a.createdAt);
      expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
      await h.close();
    });

    it("update() rejects unknown names with SkillNotFound", async () => {
      const h = await deps.make();
      await expect(h.update({ name: "ghost", description: "new" })).rejects.toBeInstanceOf(
        SkillNotFound,
      );
      await h.close();
    });

    it("remove() is idempotent", async () => {
      const h = await deps.make();
      await h.register({ name: "fade", description: "d", content: "..." });
      expect(h.has("fade")).toBe(true);
      await h.remove({ name: "fade" });
      expect(h.has("fade")).toBe(false);
      // Removing again is a no-op, not an error.
      await h.remove({ name: "fade" });
      expect(h.has("fade")).toBe(false);
      await h.close();
    });
  });

  describe("SkillsHarness — subscriptions", () => {
    it("subscribe() fires per-name", async () => {
      const h = await deps.make();
      let n = 0;
      const unsub = h.subscribe("watched", () => {
        n++;
      });
      await h.register({ name: "watched", description: "d", content: "c" });
      await h.update({ name: "watched", description: "d2" });
      expect(n).toBe(2);
      unsub();
      await h.update({ name: "watched", description: "d3" });
      expect(n).toBe(2);
      await h.close();
    });

    it("subscribeAll() fires on any mutation", async () => {
      const h = await deps.make();
      let n = 0;
      h.subscribeAll(() => {
        n++;
      });
      await h.register({ name: "a", description: "d", content: "c" });
      await h.register({ name: "b", description: "d", content: "c" });
      await h.update({ name: "a", description: "d2" });
      await h.remove({ name: "b" });
      expect(n).toBeGreaterThanOrEqual(4);
      await h.close();
    });
  });

  describe("SkillsHarness — search", () => {
    async function seed(h: SkillsHarnessProtocol): Promise<void> {
      await h.register({
        name: "git_push",
        description: "Push to remote",
        content: "git push",
        tags: ["git", "vcs"],
      });
      await h.register({
        name: "git_pull",
        description: "Pull from remote",
        content: "git pull",
        tags: ["git", "vcs"],
      });
      await h.register({
        name: "ssh_to_host",
        description: "SSH to a remote host",
        content: "ssh ...",
        tags: ["ssh", "network"],
      });
      await h.register({
        name: "docker_build",
        description: "Build a Docker image",
        content: "docker build .",
        tags: ["docker"],
      });
    }

    it("query substring filters across name + description (case-insensitive)", async () => {
      const h = await deps.make();
      await seed(h);
      const matches = h.search({ query: "REMOTE" }); // description matches
      expect(matches.map((s) => s.name).sort()).toEqual(["git_pull", "git_push", "ssh_to_host"]);
      await h.close();
    });

    it("tagsAny filters to skills carrying any named tag", async () => {
      const h = await deps.make();
      await seed(h);
      const matches = h.search({ tagsAny: ["vcs", "docker"] });
      expect(matches.map((s) => s.name).sort()).toEqual(["docker_build", "git_pull", "git_push"]);
      await h.close();
    });

    it("tagsAll requires every named tag", async () => {
      const h = await deps.make();
      await seed(h);
      const matches = h.search({ tagsAll: ["git", "vcs"] });
      expect(matches.map((s) => s.name).sort()).toEqual(["git_pull", "git_push"]);
      const empty = h.search({ tagsAll: ["git", "docker"] });
      expect(empty).toEqual([]);
      await h.close();
    });

    it("limit caps results", async () => {
      const h = await deps.make();
      await seed(h);
      const matches = h.search({ limit: 2 });
      expect(matches).toHaveLength(2);
      await h.close();
    });
  });

  /**
   * `Skill.version` — a DECLARED CONTRACT every implementation must satisfy
   * (#249), not a field that happens to survive.
   *
   * `skills:run` copies this string verbatim into the provenance stamp on every
   * message it composes, so a timeline entry answers "which revision of this
   * skill produced this" on its own. An implementation that drops `version`
   * anywhere along register → read → enumerate breaks that for every skill it
   * holds, and nothing else fails — the run still works, the messages still
   * arrive, the provenance is just quietly wrong.
   *
   * Absence is equally contractual: the framework never computes a version, so a
   * skill that declared none must read back declaring none. An implementation
   * that defaults it invents history.
   */
  describe("SkillsHarness — declared version is a contract", () => {
    it("survives register → get → list → search, and stays absent when undeclared", async () => {
      const h = await deps.make();
      await h.register({ name: "v", description: "V", content: "body", version: "1.4.0" });
      await h.register({ name: "none", description: "N", content: "body" });

      expect(h.get("v")?.version).toBe("1.4.0");
      expect(h.get("none")?.version).toBeUndefined();
      expect(h.list().find((s) => s.name === "v")?.version).toBe("1.4.0");
      expect(h.search({ query: "v" }).find((s) => s.name === "v")?.version).toBe("1.4.0");
      expect(h.search({ query: "none" }).find((s) => s.name === "none")?.version).toBeUndefined();
      await h.close();
    });

    it("update patches the version, and a patch that omits it leaves it alone", async () => {
      const h = await deps.make();
      await h.register({ name: "v", description: "V", content: "body" });

      expect((await h.update({ name: "v", version: "2" })).version).toBe("2");
      // A description-only patch is not a claim about the revision.
      expect((await h.update({ name: "v", description: "V2" })).version).toBe("2");
      await h.close();
    });
  });
}
