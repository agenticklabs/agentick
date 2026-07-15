/**
 * Wire-method augmentation — adds the knobs rows to the spec `WireMethods`
 * seed. Split out from {@link ../augment.ts} (which augments the server
 * bridge/session slots) because the CLIENT subpath needs `knobs/set` typed
 * WITHOUT loading the server-bridge augmentations — the knobs `/client`
 * handle issues `client.transport.request("knobs/set", …)`.
 *
 * Pure type-only augmentation (zero runtime), so a browser bundle importing
 * it as a side effect pulls no server code.
 *
 * ADR 51 slice 5 (#141) — `knobs/set` is the ratified user-facing wire row
 * (v1 precedent: set_knob + UI).
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { CommandInfo } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface WireMethods {
    "knobs/set": {
      params: { sessionId: string; key: string; value: unknown };
      result: unknown;
    };
    "knobs/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
