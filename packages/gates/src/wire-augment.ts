/**
 * Wire-method augmentation — adds the gates rows to the spec `WireMethods`
 * seed. Split out from the server-side {@link ./augment.ts} (which augments the
 * `SessionHarnessProtocol` slot) because the CLIENT subpath needs `gates/*`
 * typed WITHOUT loading the server augmentations — the gates `/client` handle
 * issues `client.transport.request("gates/list", …)` etc.
 *
 * Pure type-only augmentation (zero runtime), so a browser bundle importing it
 * as a side effect pulls no server code. MUST carry a top-level `import`/`export`
 * (the `import type` below suffices) so this stays a MODULE that AUGMENTS
 * `@agentick/spec` rather than a script that SHADOWS it.
 *
 * These are the ratified `exposure: "wire"` gate commands (ADR 27 GatesHarness):
 * `gates/list` (read), `gates/clear` / `gates/defer` / `gates/override`
 * (mutations), plus the `gates/commands` discovery meta-verb. Routing is the
 * generic dynamic-command lane — no per-verb gateway plumbing.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 */

import type { CommandInfo } from "@agentick/spec";
import type { GateInfo } from "./controller.js";
import type { GateValue } from "./descriptor.js";

declare module "@agentick/spec" {
  interface WireMethods {
    "gates/list": {
      params: { sessionId: string };
      result: readonly GateInfo[];
    };
    "gates/clear": {
      params: { sessionId: string; name: string };
      result: unknown;
    };
    "gates/defer": {
      params: { sessionId: string; name: string; reason?: string };
      result: unknown;
    };
    "gates/override": {
      params: { sessionId: string; name: string; value: GateValue; reason: string };
      result: unknown;
    };
    "gates/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
