---
"@agentick/core": patch
---

Default MCP resources render as a path-grouped tree (bounded size, regardless of resource count) instead of a verbose flat listing. Add `renderResources` prop on `MCPResourceComponent` / `MCPComponent` — a renderer function (not a string preset). Built-in alternates exported: `renderResourceTree` (new default), `renderResourceList` (historical behavior). Pass `() => null` to suppress the orientation Section entirely while keeping `list_resources` / `read_resource` tools registered.
