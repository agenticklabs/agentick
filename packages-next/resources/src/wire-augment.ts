/**
 * Wire-method augmentation — adds the `resources/*` rows to the spec
 * `WireMethods` seed. Split out from the server-side {@link ./augment.ts}
 * (which augments `HookBridges` + `SessionHarnessProtocol`) because the CLIENT
 * subpath needs `resources/*` typed WITHOUT loading the server augmentations —
 * the resources `/client` handle issues
 * `client.transport.request("resources/list", …)` etc.
 *
 * Pure type-only augmentation (zero runtime), so a browser bundle importing it
 * as a side effect pulls no server code. MUST carry a top-level `import`/`export`
 * (the `import type` below suffices) so this stays a MODULE that AUGMENTS
 * `@agentick/spec-next` rather than a script that SHADOWS it (the ambient-module
 * shadow trap: a `declare module` with no top-level import/export is a script,
 * which erases every export of the shadowed module).
 *
 * Resources declares its reads as `exposure: "wire"` COMMANDS
 * (`resources:read` / `resources:list` / `resources:listTemplates`,
 * `resources/src/harness.ts`), routed by the generic dynamic-command lane — no
 * per-verb gateway plumbing. These rows are the TYPE twin of that routing so a
 * typed client can call them; the single declaration lives here and is imported
 * as a side effect by BOTH the server {@link ./augment.ts} and the client
 * `./client/index.ts`.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 */

import type {
  CommandInfo,
  ResourceContents,
  ResourcesListResult,
  ResourcesListTemplatesResult,
} from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface WireMethods {
    "resources/list": {
      params: { sessionId: string; cursor?: string };
      result: ResourcesListResult;
    };
    "resources/listTemplates": {
      params: { sessionId: string; cursor?: string };
      result: ResourcesListTemplatesResult;
    };
    "resources/read": {
      params: { sessionId: string; uri: string };
      result: readonly ResourceContents[];
    };
    "resources/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
