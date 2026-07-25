/**
 * Compiler default surfacing projections (ADR 63).
 *
 * The `tools` default is compiler-agnostic and lives in
 * `@agentick/compiler` (`builtInToolsProjection`). The `timeline`
 * default needs a live timeline harness, so it is contributed here by the
 * compiler binding.
 *
 * Per ADR 27, `@agentick/compiler-react` has NO dependency on
 * `@agentick/timeline`. The timeline harness is read STRUCTURALLY
 * from `HookBridges.timeline` — the same duck-typed feature-detection
 * posture the bridge snapshot iteration uses. This keeps the timeline
 * default here (a compiler concern: "fold the conversation into IR")
 * without importing the harness package.
 *
 * The fold mirrors what `<Timeline/>` (no props) produces today: every
 * `message`-kind entry that is not `visibility: "log"`, mapped to a
 * `MessageEntry`. When no `<Timeline>` overrides the `timeline`
 * projection, this default runs and the conversation still surfaces —
 * the ADR-63 default-on behavior. When a `<Timeline>` IS present, it
 * emits a `projection-override` and this default never runs (lazy).
 *
 * Wave 4b adds two more, following the SAME structural-duck-typing seam
 * (no `@agentick/resources` / `@agentick/mcp` import — ADR 27):
 *   - `resources`     — folds the resource catalog from `bridges.resources`.
 *   - `mcpServerInfo` — folds connected-server summaries from `bridges.mcp`.
 *
 * When the session installer drives extension-registered projections
 * (ADR 26 Step 8), harness packages will contribute their own defaults
 * instead of the compiler binding reaching into bridges — until then,
 * structural duck-typing is the seam.
 *
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import type { ContentBlock, HookBridges, MessageEntry, SectionEntry } from "@agentick/spec";
import type { DefaultProjection } from "@agentick/compiler";

/** Minimal structural view of a message-kind timeline entry. */
interface StructuralMessageEntry {
  readonly kind?: string;
  readonly visibility?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly content?: readonly unknown[];
    readonly metadata?: Record<string, unknown>;
  };
}

/**
 * Read the session timeline projection structurally. Returns `undefined`
 * when no timeline bridge is present (system-only mounts) — the default
 * then contributes nothing.
 */
function readTimelineEntries(bridges: HookBridges): readonly StructuralMessageEntry[] | undefined {
  const timeline = (bridges as { timeline?: unknown }).timeline;
  if (timeline === null || timeline === undefined) return undefined;
  const read = (timeline as { read?: () => unknown }).read;
  if (typeof read !== "function") return undefined;
  const snapshot = read.call(timeline) as
    | { entries?: readonly StructuralMessageEntry[] }
    | undefined;
  const entries = snapshot?.entries;
  return Array.isArray(entries) ? entries : undefined;
}

/**
 * Build the `timeline` default projection bound to a mount's bridges.
 * Folds message entries into `MessageEntry` context entries — the same
 * fold `<Timeline/>` performs, minus compaction/filtering (those are
 * override-only concerns).
 */
export function timelineDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "timeline",
    project: () => {
      const raw = readTimelineEntries(bridges);
      if (!raw) return {};
      const entries: MessageEntry[] = [];
      for (const e of raw) {
        if (e?.kind !== "message") continue;
        if (e.visibility === "log") continue;
        const m = e.message;
        if (!m || typeof m.role !== "string") continue;
        entries.push({
          kind: "message",
          role: m.role,
          content: (m.content ?? []) as MessageEntry["content"],
          ...(m.id !== undefined ? { id: m.id } : {}),
          ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
        });
      }
      return entries.length > 0 ? { entries } : {};
    },
  };
}

// ============================================================================
// resources — application-controlled read catalog (ADR 62 / 63)
// ============================================================================

/** Minimal structural view of a `ResourcesSnapshot`. */
interface StructuralResourcesSnapshot {
  readonly resources?: readonly {
    readonly uri?: string;
    readonly name?: string;
    readonly description?: string;
    readonly mimeType?: string;
  }[];
  readonly templates?: readonly {
    readonly uriTemplate?: string;
    readonly name?: string;
    readonly description?: string;
    readonly mimeType?: string;
  }[];
}

/**
 * Read the resources registry snapshot structurally. Returns `undefined`
 * when no resources bridge is present or it doesn't expose the sync
 * `snapshot()` seam — the default then contributes nothing.
 */
function readResourcesSnapshot(bridges: HookBridges): StructuralResourcesSnapshot | undefined {
  const resources = (bridges as { resources?: unknown }).resources;
  if (resources === null || resources === undefined) return undefined;
  const snapshot = (resources as { snapshot?: () => unknown }).snapshot;
  if (typeof snapshot !== "function") return undefined;
  return snapshot.call(resources) as StructuralResourcesSnapshot | undefined;
}

/**
 * Build the `resources` default projection bound to a mount's bridges.
 * Surfaces the CATALOG (uris + names + descriptions), NOT the content —
 * resources are application-controlled and pulled on demand (ADR 62), so
 * the model reads a specific uri with `resource_read`. Contributes a
 * single `SectionEntry` when the registry is non-empty; nothing
 * otherwise. Overridable via `<Project projectionKey="resources">`.
 */
export function resourcesDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "resources",
    project: () => {
      const snap = readResourcesSnapshot(bridges);
      if (!snap) return {};
      const lines: string[] = [];
      for (const r of snap.resources ?? []) {
        if (!r || typeof r.uri !== "string") continue;
        lines.push(formatCatalogLine(r.uri, r.name, r.description, r.mimeType));
      }
      for (const t of snap.templates ?? []) {
        if (!t || typeof t.uriTemplate !== "string") continue;
        lines.push(formatCatalogLine(t.uriTemplate, t.name, t.description, t.mimeType));
      }
      if (lines.length === 0) return {};
      const content: readonly ContentBlock[] = [
        {
          type: "text",
          // Advertise availability only — don't hard-name a read tool.
          // `withResources()` exposes `resource_read` (whose own
          // description tells the model how to read); resources can also
          // be surfaced (e.g. via withMCP) without that tool present.
          text: `Readable resources the application exposes on request (by uri):\n${lines.join("\n")}`,
        } as ContentBlock,
      ];
      const entry: SectionEntry = {
        kind: "section",
        id: "resources-catalog",
        title: "Available resources",
        content,
      };
      return { entries: [entry] };
    },
  };
}

function formatCatalogLine(
  uri: string,
  name: string | undefined,
  description: string | undefined,
  mimeType: string | undefined,
): string {
  let line = `- ${uri}`;
  if (name !== undefined && name !== uri) line += ` (${name})`;
  if (description !== undefined) line += ` — ${description}`;
  if (mimeType !== undefined) line += ` [${mimeType}]`;
  return line;
}

// ============================================================================
// mcpServerInfo — connected-server summary (ADR 63)
// ============================================================================

/** Minimal structural view of one `McpServerInfo` snapshot. */
interface StructuralServerInfo {
  readonly serverId?: string;
  readonly status?: { readonly kind?: string };
  readonly implementation?: { readonly name?: string; readonly version?: string } | null;
  readonly capabilities?: Readonly<Record<string, unknown>> | null;
}

/**
 * Read connected-server info structurally off `bridges.mcp` (the
 * `{ client, clients }` slot `withMCP` publishes). Each client exposes a
 * sync `serverInfo` snapshot. Returns `undefined` when no mcp bridge is
 * present. NO `@agentick/mcp` import — pure duck-typing (ADR 27).
 */
function readMcpServerInfos(bridges: HookBridges): readonly StructuralServerInfo[] | undefined {
  const mcp = (bridges as { mcp?: unknown }).mcp;
  if (mcp === null || mcp === undefined) return undefined;
  const clients = (mcp as { clients?: unknown }).clients;
  if (!Array.isArray(clients)) return undefined;
  const out: StructuralServerInfo[] = [];
  for (const c of clients) {
    const info = (c as { serverInfo?: unknown } | null)?.serverInfo;
    if (info !== null && typeof info === "object") out.push(info as StructuralServerInfo);
  }
  return out;
}

/** Summarize a capability map to a comma list of advertised surfaces. */
function summarizeCapabilities(caps: Readonly<Record<string, unknown>> | null | undefined): string {
  if (caps === null || caps === undefined) return "";
  const known = ["tools", "resources", "prompts", "logging", "completions", "elicitation"];
  const present = known.filter((k) => caps[k] !== undefined && caps[k] !== null);
  return present.length > 0 ? present.join(", ") : "";
}

/**
 * Build the `mcpServerInfo` default projection — the ONE dedicated
 * per-connected-server surfacing (ADR 63). Folds a `SectionEntry`
 * summarizing each connected server KEYED BY THE ADOPTER ALIAS
 * (`serverInfo.serverId`), never the server's self-reported name (an
 * untrusted display label). Contributes nothing when no servers are
 * connected. Overridable via `<Project projectionKey="mcpServerInfo">`.
 */
export function mcpServerInfoDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "mcpServerInfo",
    project: () => {
      const infos = readMcpServerInfos(bridges);
      if (!infos || infos.length === 0) return {};
      const lines: string[] = [];
      for (const info of infos) {
        const alias = typeof info.serverId === "string" ? info.serverId : "(unknown)";
        const state = info.status?.kind ?? "unknown";
        // Self-reported name/version — display only, alias governs identity.
        const impl =
          info.implementation && typeof info.implementation.name === "string"
            ? `${info.implementation.name} v${info.implementation.version ?? "?"}`
            : "—";
        const caps = summarizeCapabilities(info.capabilities);
        lines.push(`- ${alias} [${state}] — ${impl}${caps ? ` — capabilities: ${caps}` : ""}`);
      }
      const content: readonly ContentBlock[] = [
        { type: "text", text: `Connected MCP servers:\n${lines.join("\n")}` } as ContentBlock,
      ];
      const entry: SectionEntry = {
        kind: "section",
        id: "mcp-server-info",
        title: "Connected MCP servers",
        content,
      };
      return { entries: [entry] };
    },
  };
}
