/**
 * The resource catalog is an INDEX, not a summary.
 *
 * ## The measurement this exists to hold
 *
 * A production prompt carried 106 resources in 35,250 characters — 36% of the
 * whole request, second only to the tool schemas. Of that, **26,977 characters
 * (77%) were descriptions**, 61 of them past 150 characters and several past 500,
 * restating the contents of a document inside the line that points at that
 * document. The model read a précis of every resource, on every request, in order
 * to decide whether to read one.
 *
 * Two changes, and the ratio between them is the point:
 *
 *   - **Glossing descriptions** — the whole win. The full text is not lost; it is
 *     inside the resource, one read away, and free until something wants it.
 *   - **Grouping by uri stem** — worth ~5% alone (the repeated
 *     `mcp://server/scheme://schema/` stem was 1,776 characters), and worth
 *     keeping because it is what makes a one-line entry legible once the prose is
 *     gone. A bare leaf name needs the stem standing over it.
 *
 * Together: 35,250 → 14,994 on that same catalog, about 5,000 tokens off every
 * request of every conversation.
 *
 * An adopter who needs the long form renders `<Resources>` with a render prop
 * (ADR 95). This is the DEFAULT, not the only shape — which is exactly why the
 * default is allowed to be opinionated about brevity.
 */

import { describe, expect, it } from "vitest";

import { fakeBridges } from "@agentick/compiler";
import type { HookBridges } from "@agentick/spec";

import { resourcesCatalogText } from "../harness/default-projections.js";

interface Resourceish {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

function bridgesWith(resources: readonly Resourceish[]): HookBridges {
  return {
    ...fakeBridges(),
    resources: { snapshot: () => ({ resources, templates: [] }) },
  } as unknown as HookBridges;
}

/** Verbatim from the capture that surfaced this — 700 characters for one entry. */
const ESTIMATED_ITEMS =
  "An EstimatedItem is a line item (Quantity × Price) — TRIPLE-purpose depending " +
  "on its parent: (1) attached to a project Milestone, it is BUDGETED materials " +
  "for that phase — the materials-estimate side of job costing (Quantity = " +
  "estimated qty). (2) On a Milestone under an IsPartsLocation=true Project, it is " +
  "ACTUAL INVENTORY at that named sub-location.";

describe("descriptions are glossed, not reproduced", () => {
  it("caps a long description well under its original length", () => {
    const text = resourcesCatalogText(
      bridgesWith([{ uri: "app://a", name: "alpha", description: ESTIMATED_ITEMS }]),
    )!;
    expect(text).toContain("An EstimatedItem is a line item");
    // The whole catalog line — uri, name and gloss — is shorter than the
    // description alone was.
    expect(text.length).toBeLessThan(ESTIMATED_ITEMS.length);
  });

  it("cuts at a boundary — a word split in half reads as corruption, not brevity", () => {
    const text = resourcesCatalogText(
      bridgesWith([{ uri: "app://a", description: ESTIMATED_ITEMS }]),
    )!;
    // Split on " — " would find the one INSIDE the description; the gloss is
    // simply what the single-entry catalog ends with.
    const clean = text.trimEnd();
    // Either a whole sentence, or an explicit ellipsis. Never a severed word.
    expect(clean.endsWith(".") || clean.endsWith("…")).toBe(true);
    expect(/\s\S{1,2}…$/.test(clean)).toBe(false);
  });

  it("leaves a short description exactly as written", () => {
    const short = "Profile of the current user.";
    const text = resourcesCatalogText(bridgesWith([{ uri: "app://me", description: short }]))!;
    expect(text).toContain(short);
    expect(text).not.toContain("…");
  });
});

describe("the catalog is a tree", () => {
  it("hoists a shared stem and lists leaves under it", () => {
    const text = resourcesCatalogText(
      bridgesWith([
        { uri: "mcp://k/x://schema/clients", description: "Clients." },
        { uri: "mcp://k/x://schema/invoices", description: "Invoices." },
      ]),
    )!;
    expect(text).toContain("mcp://k/x://schema/");
    // The leaf, not the whole uri — the stem is stated once above it.
    expect(text).toContain("- clients");
    expect(text).not.toContain("- mcp://k/x://schema/clients");
  });

  it("does NOT hoist a stem with one member — the heading would cost more than it saves", () => {
    const text = resourcesCatalogText(
      bridgesWith([
        { uri: "mcp://k/x://only/thing", description: "One." },
        { uri: "mcp://k/x://schema/a", description: "A." },
        { uri: "mcp://k/x://schema/b", description: "B." },
      ]),
    )!;
    expect(text).toContain("- mcp://k/x://only/thing");
  });

  it("every uri is still recoverable — an index nobody can act on is worse than none", () => {
    const uris = ["mcp://k/x://schema/clients", "mcp://k/x://schema/invoices", "app://solo"];
    const text = resourcesCatalogText(
      bridgesWith(uris.map((uri) => ({ uri, description: "d." }))),
    )!;
    // Reassembled from stem + leaf, which is what the model has to do to read one.
    for (const uri of uris) {
      const leaf = uri.slice(uri.lastIndexOf("/") + 1);
      expect(`${uri}=${text.includes(leaf) ? "listed" : "MISSING"}`).toBe(`${uri}=listed`);
    }
  });
});

describe("what the catalog stopped carrying", () => {
  it("drops a name that only echoes the shown slug — 'clients (clients)' says nothing twice", () => {
    const text = resourcesCatalogText(
      bridgesWith([
        { uri: "knowledge://clients", name: "clients", description: "Client records." },
        { uri: "knowledge://notes", name: "Personal notes", description: "Notes." },
      ]),
    )!;
    expect(text).not.toContain("(clients)");
    // A name that ADDS something still renders.
    expect(text).toContain("(Personal notes)");
  });

  it("drops the mime type — it was on every line and decides nothing", () => {
    const text = resourcesCatalogText(
      bridgesWith([{ uri: "app://a", description: "A.", mimeType: "text/markdown" }]),
    )!;
    expect(text).not.toContain("text/markdown");
  });

  it("an empty registry still advertises nothing rather than an empty heading", () => {
    expect(resourcesCatalogText(bridgesWith([]))).toBeUndefined();
  });
});
