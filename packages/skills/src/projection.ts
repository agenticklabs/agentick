/**
 * Skill body projection — every registered skill becomes an addressable,
 * read-only resource at `skill://<name>` whose resolver reads the LIVE harness
 * at read time.
 *
 * This is the second half of the E2 story. E2 already registers a skill's
 * supporting files at `skill://<name>/references/*` (see `references.ts`), but
 * the skill BODY itself was not addressable — an incoherence. This module closes
 * it: the whole catalog is now browsable through the standard resources surface
 * (including the MCP projection) with zero bespoke wire work.
 *
 * Two doors, one capability (three-audiences-plan §0): the `skill_read` model
 * tool is the MODEL-directed door (progressive disclosure in-band); `skill://`
 * is the UNIFORM-ADDRESSING door (MCP clients + restricted agents pull it like
 * any other resource). They coexist deliberately.
 *
 * **Universal** — no `node:*` imports. The resolver reads the live harness
 * (`harness.get(name)`), NOT the disk, so unlike the reference resolvers (which
 * close over `node:fs` on the loader side) this projection needs no Node split.
 *
 * ## Live projection
 *
 * The skills harness exposes a change-subscription seam (`subscribeAll` + the
 * sync `list()`), so this projection is LIVE: skills registered AFTER install
 * (via `skills:register` / `harness.register`) project on the next mutation, and
 * removed skills unregister. The resolver additionally reads content live, so an
 * `update` needs no re-wire — the next read reflects it.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §E2 / §0
 */

import {
  ResourceNotFound,
  type ResourceContents,
  type ResourceMeta,
  type ResourceResolver,
  type Resources,
  type SessionInstaller,
  type Skills,
  type Unsubscribe,
} from "@agentick/spec";

/** `skill://<name>` — the body-resource uri for a skill. */
export function skillBodyUri(name: string): string {
  return `skill://${name}`;
}

/**
 * Register one `skill://<name>` resource per registered skill on the session's
 * resources harness, and keep the set LIVE via the harness change-subscription.
 *
 * The resolver reads the live harness at read time — `update` is reflected
 * without a re-wire; a skill removed out from under a still-registered resource
 * (a tiny race between the mutation and the unregister) degrades to
 * `ResourceNotFound`.
 *
 * Degradation: `installer.resources` is host-constructed and normally always
 * present, but a stub installer may omit it — guard so skills still load and no
 * throw escapes. `skill://` body uris are namespaced by skill name (distinct
 * from the `skill://<name>/references/*` reference uris E2 registers), so the
 * only collision source is duplicate skill names, which `SkillAlreadyExists`
 * already rejects upstream; a stray `ResourceAlreadyRegistered` is swallowed
 * per-item so it cannot abort the rest of the wiring.
 */
export function wireSkillProjection(installer: SessionInstaller, harness: Skills): void {
  const resources = installer.resources as Resources | undefined;
  if (!resources) return; // no resources harness → skills still load, no throw

  // Retained unsubscribes keyed by skill name — the live diff registers newly
  // seen names and unregisters departed ones.
  const projected = new Map<string, Unsubscribe>();

  const register = (name: string, description: string): void => {
    const resolver: ResourceResolver = (): readonly ResourceContents[] => {
      const skill = harness.get(name);
      // Removed out from under a still-registered resource (mutation → unregister
      // race). Degrade honestly to ResourceNotFound rather than serving stale.
      if (!skill) throw new ResourceNotFound({ uri: skillBodyUri(name) });
      return [{ uri: skillBodyUri(name), mimeType: "text/markdown", text: skill.content }];
    };
    const meta: ResourceMeta = { name, description, mimeType: "text/markdown" };
    try {
      projected.set(name, resources.register(skillBodyUri(name), resolver, meta));
    } catch {
      // Duplicate uri (its owning skill name already collided upstream) — the
      // first registration wins; skip.
    }
  };

  // Diff the live skill set against what we've projected: register newly seen
  // names, unregister departed ones. `update` leaves the name set unchanged (a
  // no-op here) since the resolver reads content live.
  const sync = (): void => {
    const live = new Set<string>();
    for (const skill of harness.list()) {
      live.add(skill.name);
      if (!projected.has(skill.name)) register(skill.name, skill.description);
    }
    for (const [name, unsub] of projected) {
      if (!live.has(name)) {
        unsub();
        projected.delete(name);
      }
    }
  };

  sync(); // install-time records
  const unsubAll = harness.subscribeAll(sync); // dynamic register / remove

  installer.onClose(() => {
    unsubAll();
    for (const unsub of projected.values()) unsub();
    projected.clear();
  });
}
