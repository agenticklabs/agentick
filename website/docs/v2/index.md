# agentick v2 — preview docs

::: warning Work in progress
These pages document the **v2** APIs on the `feat/v2` branch. The rest of this
site still describes v1. A full v2 documentation pass lands nearer the v2 cut;
until then this area holds guides written against the shipped v2 packages
(`@agentick/*-next`). Import paths use the `-next` workspace packages — at the
cut they collapse to the bundled `agentick` metapackage.
:::

## Guides

- [**Resources**](/docs/v2/resources) — application-controlled, URI-addressed
  content the model pulls on demand. Tools are verbs the model calls; resources
  are nouns the model reads.
- [**MCP: Connecting to Servers**](/docs/v2/mcp) — connect a session to remote
  MCP servers with `withMCP`: tool discovery, resource surfacing, roots, and
  transports.
- [**Exposing an MCP Server**](/docs/v2/mcp-server) — project your own tools,
  prompts, and resources onto the wire as an MCP server.

These three sit together for a reason: resources is a native framework primitive,
and MCP is one projection of it (and of tools, prompts, elicitation, and
log/progress signals). Read **Resources** first — the MCP guides build on it.
