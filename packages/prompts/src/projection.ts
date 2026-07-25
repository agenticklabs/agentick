/**
 * Prompt projection — every registered prompt becomes an addressable, read-only
 * resource at `prompt://<name>` whose resolver reads the LIVE harness at read
 * time. The prompt catalog becomes browsable through the standard resources
 * surface (including the MCP projection) with zero bespoke wire work.
 *
 * Two doors, one capability (three-audiences-plan §0): prompts are USER-directed
 * (invoked by the human via `prompts.invoke`); `prompt://` is the
 * UNIFORM-ADDRESSING door (MCP clients + restricted agents browse the catalog
 * like any other resource).
 *
 * **Universal** — no `node:*` imports. The resolver reads the live harness
 * (`harness.get(name)`).
 *
 * ## Content decision — never fake a render
 *
 * A prompt's payload is EITHER a static `template` OR a dynamic `render(args)`
 * function; the harness picks `render` first at invoke time. Neither is
 * guaranteed serializable — `render` is a closure, and `template` is
 * framework-typed `unknown` (a React node, say). So the projection serves:
 *
 *  - the `template` as `text/markdown` ONLY when it is a plain string AND no
 *    `render` fn shadows it (the honest, serializable case); otherwise
 *  - a DECLARATION DOCUMENT (`application/json`) of `{ name, description,
 *    arguments }` — the serializable metadata a browser needs to decide whether
 *    to invoke the prompt. Argument `schema` validators are dropped (they carry
 *    a `~standard` fn); only `{ name, description?, required? }` project.
 *
 * We never serialize a function and never pretend a render result is the prompt.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §0
 */

import {
  ResourceNotFound,
  type PromptDeclaration,
  type ResourceContents,
  type ResourceMeta,
  type ResourceResolver,
  type Resources,
  type Prompts,
  type SessionInstaller,
  type Unsubscribe,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

/** `prompt://<name>` — the resource uri for a prompt. */
export function promptUri(name: string): string {
  return `prompt://${name}`;
}

/** True when the prompt's payload is a serve-as-is static string template. */
function servesTemplate(decl: PromptDeclaration): boolean {
  return decl.render === undefined && typeof decl.template === "string";
}

/** The resolved contents for a prompt — string template, else declaration doc. */
function projectPromptContents(decl: PromptDeclaration, uri: string): ResourceContents {
  if (servesTemplate(decl)) {
    return { uri, mimeType: "text/markdown", text: decl.template as string };
  }
  // Declaration document — the serializable metadata slice. Argument `schema`
  // validators are non-serializable (a `~standard` fn), so only name /
  // description / required project.
  const doc = {
    name: decl.name,
    description: decl.description,
    arguments: (decl.arguments ?? []).map((a) =>
      omitUndefined({ name: a.name, description: a.description, required: a.required }),
    ),
  };
  return { uri, mimeType: "application/json", text: JSON.stringify(doc, null, 2) };
}

/**
 * Register one `prompt://<name>` resource per registered prompt on the session's
 * resources harness, and keep the set LIVE via the harness change-subscription
 * (`subscribeAll` + the sync `list()`). Prompts registered after install project
 * on the next mutation; removed prompts unregister. The resolver reads content
 * live, so an `update` needs no re-wire.
 *
 * Degradation: `installer.resources` may be absent on a stub installer — guard
 * so prompts still load and no throw escapes. A skill/prompt removed out from
 * under a still-registered resource degrades to `ResourceNotFound`.
 */
export function wirePromptProjection(installer: SessionInstaller, harness: Prompts): void {
  const resources = installer.resources as Resources | undefined;
  if (!resources) return; // no resources harness → prompts still load, no throw

  const projected = new Map<string, Unsubscribe>();

  const register = (decl: PromptDeclaration): void => {
    const name = decl.name;
    const uri = promptUri(name);
    const resolver: ResourceResolver = (): readonly ResourceContents[] => {
      const live = harness.get(name);
      if (!live) throw new ResourceNotFound({ uri });
      return [projectPromptContents(live, uri)];
    };
    // Meta mimeType matches the content decision AT REGISTRATION — a prompt's
    // template/render shape is fixed for its lifetime, so this stays accurate.
    const meta: ResourceMeta = {
      name,
      description: decl.description,
      mimeType: servesTemplate(decl) ? "text/markdown" : "application/json",
    };
    try {
      projected.set(name, resources.register(uri, resolver, meta));
    } catch {
      // Duplicate uri — first registration wins; skip.
    }
  };

  const sync = (): void => {
    const live = new Set<string>();
    for (const decl of harness.list()) {
      live.add(decl.name);
      if (!projected.has(decl.name)) register(decl);
    }
    for (const [name, unsub] of projected) {
      if (!live.has(name)) {
        unsub();
        projected.delete(name);
      }
    }
  };

  sync(); // install-time records
  const unsubAll = harness.subscribeAll(sync); // dynamic register / remove

  installer.onClose(() => {
    unsubAll();
    for (const unsub of projected.values()) unsub();
    projected.clear();
  });
}
