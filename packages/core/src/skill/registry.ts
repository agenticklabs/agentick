/**
 * SkillRegistry — discovery + retrieval surface for an app's skills.
 *
 * Mirrors the Agent Skills spec's "stage 1 (discovery)" model: a host
 * registers skills with their metadata; the model and programmatic
 * callers can list, search, and look skills up by name. The full body
 * of a skill loads only when invoked (stage 2).
 *
 * @module @agentick/core/skill/registry
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSkill } from "./loader.js";
import type { SkillDef } from "./skill.js";

export interface SkillSearchQuery {
  /**
   * Free-text query matched against name, description, when_to_use, and
   * metadata values (case-insensitive substring).
   */
  query?: string;

  /**
   * Filter by metadata key/value pairs. All entries must match exactly
   * (string equality) for a skill to be included.
   */
  metadata?: Record<string, string>;

  /**
   * Maximum number of results to return.
   */
  limit?: number;
}

/**
 * In-memory registry of skills available to an app. Owned by the app
 * (`app.skills`); sessions consult it to resolve string-name references
 * and to expose the implicit `skill` tool listing.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDef>();
  private readonly listeners = new Set<(skills: SkillDef[]) => void>();

  /**
   * Register a skill. Throws on name collision; use `replace()` if you
   * mean to overwrite.
   */
  register(skill: SkillDef): void {
    if (this.skills.has(skill.name)) {
      throw new Error(
        `SkillRegistry: skill "${skill.name}" already registered. Use replace() to overwrite.`,
      );
    }
    this.skills.set(skill.name, skill);
    this.notify();
  }

  /**
   * Register or overwrite a skill by name. Returns true if a previous
   * registration was replaced.
   */
  replace(skill: SkillDef): boolean {
    const had = this.skills.has(skill.name);
    this.skills.set(skill.name, skill);
    this.notify();
    return had;
  }

  /** Look up a skill by name. */
  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  /** True if a skill is registered under this name. */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** All registered skills, in registration order. */
  list(): SkillDef[] {
    return [...this.skills.values()];
  }

  /** Number of registered skills. */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Remove a registered skill by name. Returns true if a registration
   * was removed.
   */
  unregister(name: string): boolean {
    const had = this.skills.delete(name);
    if (had) this.notify();
    return had;
  }

  /** Remove all registrations. */
  clear(): void {
    if (this.skills.size === 0) return;
    this.skills.clear();
    this.notify();
  }

  /**
   * Search the registry. Filters apply with AND semantics (a skill must
   * match every provided filter to be included).
   */
  search(query: SkillSearchQuery = {}): SkillDef[] {
    const q = query.query?.toLowerCase().trim();
    const meta = query.metadata;

    const matches: SkillDef[] = [];
    for (const skill of this.skills.values()) {
      if (q && !skillMatchesText(skill, q)) continue;
      if (meta && !skillMatchesMetadata(skill, meta)) continue;
      matches.push(skill);
      if (query.limit && matches.length >= query.limit) break;
    }
    return matches;
  }

  /**
   * Subscribe to registry changes. Fires after every register/replace/
   * unregister/clear with the current full skill list. Returns an
   * unsubscribe function.
   */
  subscribe(listener: (skills: SkillDef[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Load all skills from a directory. Each subdirectory is treated as a
   * folder-based skill (its `SKILL.md` is loaded with strict spec
   * validation). Bare `.md` files at the top level are ignored.
   *
   * @example
   * ```typescript
   * await app.skills.loadDir("./skills");
   * // Loads ./skills/triage/SKILL.md, ./skills/plan/SKILL.md, etc.
   * ```
   */
  async loadDir(dirPath: string): Promise<SkillDef[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const loaded: SkillDef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = join(dirPath, entry.name);
      // Probe for SKILL.md before delegating; cleaner errors than relying
      // on loadSkill to surface ENOENT for whole subdirs that don't have it.
      try {
        await stat(join(sub, "SKILL.md"));
      } catch {
        continue;
      }
      const skill = await loadSkill(sub);
      this.replace(skill); // replace, not register — loading a dir twice should refresh
      loaded.push(skill);
    }
    return loaded;
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        // Listener errors don't block the registry, but they should not be
        // silent — a broken subscriber that disappears with no signal is a
        // real debugging trap.
        // eslint-disable-next-line no-console
        console.warn("[SkillRegistry] subscriber threw:", err);
      }
    }
  }
}

// ============================================================================
// Search helpers
// ============================================================================

function skillMatchesText(skill: SkillDef, q: string): boolean {
  if (skill.name.toLowerCase().includes(q)) return true;
  if (skill.description.toLowerCase().includes(q)) return true;
  if (skill.whenToUse?.toLowerCase().includes(q)) return true;
  if (skill.metadata) {
    for (const v of Object.values(skill.metadata)) {
      if (v.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

function skillMatchesMetadata(skill: SkillDef, filter: Record<string, string>): boolean {
  if (!skill.metadata) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (skill.metadata[k] !== v) return false;
  }
  return true;
}
