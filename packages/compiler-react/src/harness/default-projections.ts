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

import type { ContentBlock, HookBridges, MessageEntry } from "@agentick/spec";
import { sectionBlock } from "@agentick/formatters";
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
 * the model reads a specific uri with `resource_read`. Contributes a single
 * `grounding` message when the registry is non-empty; nothing otherwise.
 *
 * It lands where every default projection lands — appended after the
 * tree-order stream, so AFTER the timeline. A default has no tree position
 * to claim (ADR 94: position decides order, and this content was never
 * placed). An adopter who wants the catalog somewhere specific overrides the
 * key with `<Project projectionKey="resources">` and puts it there.
 */
/**
 * The catalog TEXT, or undefined when there is nothing to advertise.
 *
 * Extracted so the default projection and the `<Resources />` component render
 * the SAME bytes from ONE implementation. Two copies of this would drift, and
 * an adopter who repositioned the catalog would silently get different content
 * than the default — the failure mode that makes "override to reposition"
 * unusable in the first place.
 */
export function resourcesCatalogText(bridges: HookBridges): string | undefined {
  const snap = readResourcesSnapshot(bridges);
  if (!snap) return undefined;
  const entries: CatalogEntry[] = [];
  for (const r of snap.resources ?? []) {
    if (!r || typeof r.uri !== "string") continue;
    entries.push({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType });
  }
  for (const t of snap.templates ?? []) {
    if (!t || typeof t.uriTemplate !== "string") continue;
    entries.push({
      uri: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
    });
  }
  if (entries.length === 0) return undefined;
  const lines = groupByPrefix(entries);
  // Advertise availability only — don't hard-name a read tool.
  // `withResources()` exposes `resource_read` (whose own description tells the
  // model how to read); resources can also be surfaced (e.g. via withMCP)
  // without that tool present.
  return `Readable resources the application exposes on request (by uri):\n${lines.join("\n")}`;
}

export function resourcesDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "resources",
    project: () => {
      const text = resourcesCatalogText(bridges);
      if (text === undefined) return {};
      const content: readonly ContentBlock[] = [{ type: "text", text } as ContentBlock];
      const entry: MessageEntry = {
        kind: "message",
        role: "grounding",
        id: "resources-catalog",
        content: [sectionBlock({ id: "resources-catalog", title: "Available resources", content })],
      };
      return { entries: [entry] };
    },
  };
}

interface CatalogEntry {
  readonly uri: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

/**
 * How much of a resource's own description the CATALOG carries.
 *
 * A catalog is an INDEX, not a summary. Measured on a production prompt: 106
 * resources, 35,250 characters, of which **26,977 (77%) were descriptions** and
 * 61 of them ran past 150 characters — several past 500, restating the contents
 * of a document in the line that points at that document. The model was reading a
 * précis of every resource, on every request, to decide whether to read one.
 *
 * The full text is not lost: it is inside the resource, one `resource_read` away,
 * and it costs nothing until something wants it. An adopter who genuinely needs
 * the long form renders `<Resources>` with a render prop (ADR 95) and formats the
 * snapshot however they like — this is the DEFAULT, not the only shape.
 */
const CATALOG_GLOSS_MAX = 100;

/** First sentence, capped — enough to tell two resources apart and no more. */
function gloss(description: string): string {
  const trimmed = description.trim().replace(/\s+/g, " ");
  if (trimmed.length <= CATALOG_GLOSS_MAX) return trimmed;
  // Prefer a sentence boundary, then a word boundary — a description cut
  // mid-word reads as corrupted output rather than as an abbreviation.
  const stop = trimmed.slice(0, CATALOG_GLOSS_MAX).lastIndexOf(". ");
  if (stop > CATALOG_GLOSS_MAX / 2) return trimmed.slice(0, stop + 1);
  const space = trimmed.slice(0, CATALOG_GLOSS_MAX).lastIndexOf(" ");
  return `${trimmed.slice(0, space > 0 ? space : CATALOG_GLOSS_MAX)}…`;
}

/**
 * Everything up to and including the last `/` — the shared stem a tree hangs on.
 */
function stemOf(uri: string): string {
  const cut = uri.lastIndexOf("/");
  return cut <= 0 ? "" : uri.slice(0, cut + 1);
}

/**
 * The catalog as a shallow tree, grouped by uri stem.
 *
 * Worth ~5% on its own — the repeated `mcp://server/scheme://schema/` stem was
 * 1,776 of 35,250 characters. It earns its place by making the TRUNCATION legible:
 * once descriptions are one line, a bare leaf name is ambiguous without the stem
 * standing over it.
 *
 * Groups of one are inlined rather than given a heading of their own, which would
 * cost more than it saved.
 */
function groupByPrefix(entries: readonly CatalogEntry[]): string[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const stem = stemOf(entry.uri);
    const bucket = groups.get(stem) ?? [];
    bucket.push(entry);
    groups.set(stem, bucket);
  }
  const out: string[] = [];
  for (const [stem, bucket] of groups) {
    const grouped = stem !== "" && bucket.length > 1;
    if (grouped) out.push(`${stem}`);
    for (const entry of bucket) {
      out.push(formatCatalogLine(entry, grouped ? stem : ""));
    }
  }
  return out;
}

function formatCatalogLine(entry: CatalogEntry, stem: string): string {
  const shown =
    stem !== "" && entry.uri.startsWith(stem) ? entry.uri.slice(stem.length) : entry.uri;
  let line = `${stem !== "" ? "  " : ""}- ${shown}`;
  if (entry.name !== undefined && entry.name !== entry.uri) line += ` (${entry.name})`;
  if (entry.description !== undefined) line += ` — ${gloss(entry.description)}`;
  // The mime type is dropped: it was on every line, it is `text/markdown` for
  // almost all of them, and nothing the model decides turns on it.
  return line;
}

// ============================================================================
// mcpServerInfo — connected-server summary (ADR 63)
// ============================================================================

/** Minimal structural view of one `McpServerInfo` snapshot. */
export interface StructuralServerInfo {
  readonly serverId?: string;
  readonly status?: { readonly kind?: string };
  readonly implementation?: { readonly name?: string; readonly version?: string } | null;
  readonly capabilities?: Readonly<Record<string, unknown>> | null;
  /** The server's own `InitializeResult.instructions` — see `mcpServersText`. */
  readonly instructions?: string | null;
}

/**
 * Read connected-server info structurally off `bridges.mcp` (the
 * `{ client, clients }` slot `withMCP` publishes). Each client exposes a
 * sync `serverInfo` snapshot. Returns `undefined` when no mcp bridge is
 * present. NO `@agentick/mcp` import — pure duck-typing (ADR 27).
 */
export function readMcpServerInfos(
  bridges: HookBridges,
): readonly StructuralServerInfo[] | undefined {
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
export function mcpServerInfoDefaultProjection(bridges: HookBridges): DefaultProjection {
  return {
    key: "mcpServerInfo",
    project: () => {
      const text = mcpServersText(bridges);
      if (text === undefined) return {};
      const content: readonly ContentBlock[] = [{ type: "text", text } as ContentBlock];
      const entry: MessageEntry = {
        kind: "message",
        role: "grounding",
        id: "mcp-server-info",
        content: [sectionBlock({ id: "mcp-server-info", title: "Connected MCP servers", content })],
      };
      return { entries: [entry] };
    },
  };
}

function summarizeCapabilities(caps: Readonly<Record<string, unknown>> | null | undefined): string {
  if (caps === null || caps === undefined) return "";
  const known = ["tools", "resources", "prompts", "logging", "completions", "elicitation"];
  const present = known.filter((k) => caps[k] !== undefined && caps[k] !== null);
  return present.length > 0 ? present.join(", ") : "";
}

/**
 * Build the `mcpServerInfo` default projection — the ONE dedicated
 * per-connected-server surfacing (ADR 63). Folds a `grounding` message
 * summarizing each connected server KEYED BY THE ADOPTER ALIAS
 * (`serverInfo.serverId`), never the server's self-reported name (an
 * untrusted display label). Contributes nothing when no servers are
 * connected. Overridable via `<Project projectionKey="mcpServerInfo">`.
 */
/**
 * The connected-server summary TEXT, or undefined when none are connected.
 * Shared with `<McpServers />` — see {@link resourcesCatalogText} on why this
 * is one implementation and not two.
 */
export function mcpServersText(bridges: HookBridges): string | undefined {
  const infos = readMcpServerInfos(bridges);
  if (!infos || infos.length === 0) return undefined;
  const lines: string[] = [];
  for (const info of infos) {
    lines.push(mcpServerLine(info));
  }
  let out = `Connected MCP servers:\n${lines.join("\n")}`;

  // A server's own `instructions` — the one field in `InitializeResult` whose
  // entire purpose is to reach the prompt. It was captured and then dropped:
  // a server telling the model how to use it, and we rendered `capabilities:`
  // instead. Rendered UNDER THE SERVER'S OWN HEADING, never merged into the
  // application's prose, so the model can tell whose voice it is — the same
  // provenance reason the summary is keyed by adopter alias rather than by the
  // server's self-reported name.
  for (const info of infos) {
    const instructions = typeof info.instructions === "string" ? info.instructions.trim() : "";
    if (instructions === "") continue;
    const alias = typeof info.serverId === "string" ? info.serverId : "(unknown)";
    out += `\n\n### ${alias} — server instructions\n${instructions}`;
  }
  return out;
}

/**
 * ONE server's summary line, keyed by the ADOPTER ALIAS (`serverId`) rather
 * than the server's self-reported name, which is an untrusted display label.
 * Exported because `<McpServerContext>` renders exactly this — partial
 * override ("customize one of twenty") is only possible if the default for the
 * other nineteen is reachable.
 */
export function mcpServerLine(info: StructuralServerInfo): string {
  const alias = typeof info.serverId === "string" ? info.serverId : "(unknown)";
  const state = info.status?.kind ?? "unknown";
  const impl =
    info.implementation && typeof info.implementation.name === "string"
      ? `${info.implementation.name} v${info.implementation.version ?? "?"}`
      : "—";
  const caps = summarizeCapabilities(info.capabilities);
  return `- ${alias} [${state}] — ${impl}${caps ? ` — capabilities: ${caps}` : ""}`;
}
