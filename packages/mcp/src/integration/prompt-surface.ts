/**
 * Project a remote MCP server's PROMPTS into the session's prompts namespace, so they
 * surface wherever the app's own prompts do — a slash-command palette, `prompts.list()`.
 *
 * Sibling of `./resource-surface.ts`, and deliberately the same shape: a narrow
 * structural client rather than the whole `McpClientHarness`, so this is testable
 * against a REAL `PromptsHarness` with no live transport.
 *
 * ## Registered, not hydrated
 *
 * The prompts namespace has a hydrator seam (`composeHydrators`,
 * `hydrateFromModule`, …) which looked like the idiomatic home for this. It reads worse:
 * a `hydrateFromMcp({ serverId })` composed into `definePrompts` makes the adopter write
 * `serverId` twice — once in `withMCP({ servers })`, once in the hydrator — which is a
 * coupling the API hands back to them to maintain. Tools and resources arrive without
 * being asked for; prompts needing manual composition is the inconsistency someone files
 * as a bug.
 *
 * ## Content comes from the remote, every time
 *
 * `render` returns `MessageEntry[]`, which the harness passes through untouched
 * (`isMessageEntryArray`), so a projected prompt needs no renderer and no JSX. It calls
 * `prompts/get` on each invoke rather than caching a rendering, so a server whose prompt
 * text changes without emitting `list_changed` still serves the current one.
 */

import type { MessageEntry, PromptArgument, Prompts, Unsubscribe } from "@agentick/spec";

import type { McpGetPromptResult, McpPromptPage } from "../client/types.js";

/** The slice of an MCP client this projection needs. */
export interface RemotePromptClient {
  listPrompts(cursor?: string): Promise<McpPromptPage>;
  getPrompt(name: string, args?: Readonly<Record<string, string>>): Promise<McpGetPromptResult>;
}

/**
 * Register every prompt the server advertises, returning one teardown each.
 *
 * `prefix` guards collisions the same way `toolPrefix` does — two servers may both publish
 * `job_profitability`, and a collision that silently kept one would leave a prompt simply
 * missing from a user's palette. Pass `""` for bare names when there is one server and the
 * prompts are user-facing: `/jobs_over_budget` reads better than
 * `/knowify__jobs_over_budget`.
 */
export async function surfaceRemotePrompts(
  prompts: Prompts,
  serverId: string,
  prefix: string,
  client: RemotePromptClient,
): Promise<readonly Unsubscribe[]> {
  const unsubscribes: Unsubscribe[] = [];
  let cursor: string | undefined;

  // Paginated, like the resource surface: a server with many prompts advertises them
  // across pages, and stopping at the first would silently truncate the palette.
  do {
    const page = await client.listPrompts(cursor);
    for (const descriptor of page.prompts) {
      const localName = `${prefix}${descriptor.name}`;
      const args: readonly PromptArgument[] | undefined = descriptor.arguments?.map((a) => ({
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.required !== undefined ? { required: a.required } : {}),
      }));
      await prompts.register({
        declaration: {
          name: localName,
          // Three distinct facts, kept distinct: the id, the label, the subtitle. Folding
          // title into description loses it whenever a server supplies both.
          ...(descriptor.title !== undefined ? { title: descriptor.title } : {}),
          description: descriptor.description ?? descriptor.title ?? descriptor.name,
          ...(args !== undefined ? { arguments: args } : {}),
          render: async (invokeArgs: Readonly<Record<string, unknown>>) => {
            const result = await client.getPrompt(
              descriptor.name,
              invokeArgs as Record<string, string>,
            );
            return result.messages.map(
              (m): MessageEntry =>
                ({ kind: "message", role: m.role, content: m.content }) as MessageEntry,
            );
          },
          // The remote identity, so a consumer can tell a projected prompt from a local
          // one and route back to its server.
          metadata: { mcp: { serverId, remoteName: descriptor.name } },
        },
      });
      unsubscribes.push(() => {
        void prompts.remove({ name: localName });
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return unsubscribes;
}
