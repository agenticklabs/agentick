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
 *
 * ## Completion is a forwarding resolver
 *
 * Same rule, applied to the argument slots: each folded argument gets an inline
 * `complete` whose body re-asks the ORIGIN server (`completion/complete`), and the
 * resolver's `ctx.resolvedArguments` — the siblings the composer has filled — rides
 * along as MCP's `context.arguments`. That is what makes "which phase of *that* job?"
 * answerable through the native seam (completions.md §2.4, the inward direction). Four
 * completion surfaces, one seam.
 */

import type {
  CompletionCtx,
  CompletionResult,
  MessageEntry,
  PromptArgument,
  Prompts,
  Unsubscribe,
} from "@agentick/spec";

import type { McpCompletionContext, McpGetPromptResult, McpPromptPage } from "../client/types.js";

/** The slice of an MCP client this projection needs. */
export interface RemotePromptClient {
  listPrompts(cursor?: string): Promise<McpPromptPage>;
  getPrompt(name: string, args?: Readonly<Record<string, string>>): Promise<McpGetPromptResult>;
  completePromptArgument(
    promptName: string,
    argumentName: string,
    value: string,
    context?: McpCompletionContext,
  ): Promise<CompletionResult>;
  /**
   * What the origin advertised at `initialize`, when the caller can see it —
   * `McpClientHarness.serverInfo` satisfies this structurally. Read for ONE
   * decision: whether to attach a forwarding `complete` at all. `null`
   * (pre-handshake) or an absent property means attach — an unadvertised server
   * answers `method not found`, which the resolver already folds to empty.
   */
  readonly serverInfo?: { readonly capabilities: Readonly<Record<string, unknown>> | null };
}

/**
 * Does the origin server answer `completion/complete`?
 *
 * MCP negotiates `completions` once at `initialize`, and `prompts/list` carries no
 * per-argument completability metadata — so this is the only signal available, and it is
 * a whole-server one. Unknown counts as YES: a client slice that cannot see capabilities
 * (a test fake, a narrower client) should still complete, and the cost of being wrong is
 * one `method not found` per keystroke folded to empty values rather than a dead slot the
 * user has no way to diagnose.
 */
function advertisesCompletions(client: RemotePromptClient): boolean {
  const caps = client.serverInfo?.capabilities;
  return caps === undefined || caps === null || caps.completions !== undefined;
}

/**
 * The forwarding resolver for one folded argument: re-ask the origin server, with the
 * composer's already-filled siblings as MCP's `context.arguments`.
 *
 * A failure answers EMPTY rather than throwing. This fires per keystroke, and the two
 * likely failures — a server that advertised `completions` but declines this particular
 * ref (`method not found`, unknown prompt) and a momentary transport fault — are both
 * "nothing to offer" from the composer's side; a throw would instead surface as
 * `CompletionResolveFailed` on every character typed. The reason survives on the
 * resolver's own `ctx.log` at debug, so a dead slot stays diagnosable.
 */
function forwardCompletion(
  client: RemotePromptClient,
  promptName: string,
  argumentName: string,
): (value: string, ctx: CompletionCtx) => Promise<CompletionResult> {
  return async (value, ctx) => {
    // TODO(mcp-complete-abort): `ctx.signal` is dropped — the client's completion verb
    // is a declared command and its invoker takes no `AbortSignal`, so latest-wins
    // cancellation stops at this boundary (the superseded request still round-trips).
    // Threading it needs a signal on the command invoker, not a change here.
    try {
      return await client.completePromptArgument(promptName, argumentName, value, {
        arguments: ctx.resolvedArguments,
      });
    } catch (cause) {
      ctx.log.debug({
        msg: "mcp forwarded completion failed; answering empty",
        prompt: promptName,
        argument: argumentName,
        cause,
      });
      return { values: [] };
    }
  };
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
  const completable = advertisesCompletions(client);

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
        // EVERY argument, not a selected few: `prompts/list` carries no per-argument
        // completability flag, so the only way to find out is to ask. A server with
        // nothing to say for this one answers empty values — which is exactly the
        // composer's dismissal, and one cheap round-trip.
        ...(completable ? { complete: forwardCompletion(client, descriptor.name, a.name) } : {}),
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
