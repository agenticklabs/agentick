/**
 * `skillsHandle` — the client-side skills resource handle, on the unified
 * `ClientHandle` contract (ADR 87). The wire twin of the server
 * `session.skills` (`SkillsHandle`): nouns + verbs over one session's skill
 * library.
 *
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current {@link Skill}s,
 *     `get(name)` looks one up by name (over the local snapshot).
 *   - READ — `search(input)` rides `skills/search` (fresh query; does NOT
 *     mutate the snapshot), `refresh()` re-polls `skills/list`.
 *   - VERBS — `register` / `update` / `remove`, each a `skills/*` wire command
 *     followed by a re-poll.
 *
 * **RPC-backed, NOT channel-backed — the deliberate divergence from
 * `knobs`/`tasks`.** There is no `skills-state` delta channel (a reactive client
 * mirror rides the client channel-consumer primitive, not this PR). So the read
 * side is a poll, not a live mirror: the handle keeps a local snapshot seeded by
 * an eager `skills/list` fetch and RE-FETCHES after every mutation
 * (fire-and-refetch — the RPC analog of the channel-backed handles'
 * fire-and-observe CQRS). `list()`/`get()` read that snapshot synchronously (the
 * `Enumerable` contract, so the handle drops into `useSyncExternalStore`);
 * `refresh()` forces a re-poll. `subscribe(cb)` fires whenever the snapshot
 * changes (after the initial fetch and after each mutation's re-fetch).
 *
 * NO `run` — `skills:run` is not a wire command (deferred; needs the
 * declarative structured-output form). NO `reload`/`resolve`/`require` — those
 * are loader / lookup-on-miss server concerns that do not cross the wire.
 *
 * @verifiedBy packages/skills/src/client/__tests__/skills-handle.spec.ts
 * @verifiedBy packages/skills/src/client/__tests__/session-skills.spec.ts
 */

import { polledView, type ClientHandle, type Enumerable } from "@agentick/client-core";
import type {
  ClientTransport,
  Skill,
  SkillsRegisterInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
} from "@agentick/spec";

/** Command client: the `request` surface the skills handle rides (RPC-only). */
export interface SkillsCommandClient {
  readonly transport: Pick<ClientTransport, "request">;
}

/**
 * The skills resource handle: the {@link Enumerable} skill view (`list` / `get`)
 * over the local snapshot + the store-contract `subscribe` + `search` (fresh
 * query) + the `register` / `update` / `remove` write commands + `refresh`
 * (force a re-poll). A plain structural shape (floors, not ceilings) — it MAY
 * carry more.
 */
export interface SkillsClientHandle extends ClientHandle, Enumerable<Skill> {
  /** The current skills as a bounded snapshot (from the last `skills/list` poll). */
  list(): readonly Skill[];
  /** Look one skill up by name; `undefined` when absent (or not yet fetched). */
  get(name: string): Skill | undefined;
  /**
   * Substring + tag search over `skills/search`. Returns the fresh server
   * result; does NOT mutate the local `list()` snapshot (a query, not a poll).
   */
  search(input: SkillsSearchInput): Promise<readonly Skill[]>;
  /** Register a skill. Issues `skills/register`, then re-polls the snapshot. */
  register(input: SkillsRegisterInput): Promise<void>;
  /** Update a skill. Issues `skills/update`, then re-polls. */
  update(input: SkillsUpdateInput): Promise<void>;
  /** Remove a skill by name. Issues `skills/remove`, then re-polls. */
  remove(input: SkillsRemoveInput): Promise<void>;
  /** Force a `skills/list` re-poll; resolves with the fresh snapshot. */
  refresh(): Promise<readonly Skill[]>;
  /** Tear down: drop listeners (no channel subscription to close). */
  close(): void;
}

/**
 * A read+write handle over `session`'s skills. The read half polls `skills/list`
 * (eagerly at construction, and after every mutation); the write half issues
 * the `skills/*` commands.
 */
export function skillsHandle(client: SkillsCommandClient, sessionId: string): SkillsClientHandle {
  const view = polledView<Skill>({
    // Only the FIRST page seeds the snapshot — walking cursors is the power-user
    // path (`refresh` re-polls page one), matching the resources handle.
    fetch: async () => (await client.transport.request("skills/list", { sessionId }))?.skills,
    key: (s) => s.name,
  });

  return {
    ...view,
    search: async (input) => {
      const rows = (await client.transport.request("skills/search", { sessionId, ...input })) as
        | readonly Skill[]
        | null
        | undefined;
      return rows ?? [];
    },
    register: async (input) => {
      await client.transport.request("skills/register", { sessionId, ...input });
      await view.refresh();
    },
    update: async (input) => {
      await client.transport.request("skills/update", { sessionId, ...input });
      await view.refresh();
    },
    remove: async (input) => {
      await client.transport.request("skills/remove", { sessionId, ...input });
      await view.refresh();
    },
  };
}
