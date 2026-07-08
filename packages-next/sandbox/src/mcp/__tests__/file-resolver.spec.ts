/**
 * File → readable-resource projection (ADR 65 / ADR 62).
 *
 * Pins: `sandboxFileResolver` reads a file's content THROUGH the sandbox
 * and returns it as `ResourceContents` (text round-trips; a binary path
 * degrades to best-effort text, never a throw); `fsFileResolver` is the
 * no-sandbox path (lossless text + base64-blob binary, root-contained);
 * and `registerFileResolver` wires either onto a real `ResourcesHarness`
 * so `read(file://…)` routes through it.
 *
 * @verifiedBy this file — sandboxFileResolver + fsFileResolver + registerFileResolver.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { ResourcesHarness } from "@agentick/resources-next";
import type { TextResourceContents, BlobResourceContents } from "@agentick/spec-next";

import { SandboxHarness } from "../../harness.js";
import { fakeSandboxProvider } from "../../testing/fake.js";
import {
  sandboxFileResolver,
  fsFileResolver,
  registerFileResolver,
  pathToFileUri,
} from "../index.js";

async function seededSandbox(files: Record<string, string>): Promise<SandboxHarness> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const elicitation = new ElicitationHarness("fr:elicitation", journal, bus, inbox);
  await elicitation.ready;
  const harness = await SandboxHarness.fromProvider(journal, bus, inbox, {
    sandboxId: "fr-sb",
    provider: fakeSandboxProvider({ files }),
    options: {},
    // Allow reads under the workspace so the resolver's `read-file`
    // command isn't gated behind an interactive elicitation prompt.
    acl: { read: ["/workspace/**"] },
    elicitation,
  });
  await harness.ready;
  return harness;
}

function makeResources(): ResourcesHarness {
  return new ResourcesHarness(
    "fr:resources",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
}

describe("sandboxFileResolver (ADR 65 / ADR 62 — read through the sandbox)", () => {
  it("round-trips a text file's content as resource content", async () => {
    const sandbox = await seededSandbox({ "/workspace/hello.txt": "hello roots" });
    const resolver = sandboxFileResolver(sandbox);
    const contents = await resolver("file:///workspace/hello.txt");
    expect(contents).toEqual([
      { uri: "file:///workspace/hello.txt", mimeType: "text/plain", text: "hello roots" },
    ]);
  });

  it("degrades a binary path sanely — best-effort text, guessed mime, no throw", async () => {
    const sandbox = await seededSandbox({ "/workspace/logo.png": "\x89PNG\r\n" });
    const resolver = sandboxFileResolver(sandbox);
    const contents = await resolver("file:///workspace/logo.png");
    expect(contents).toHaveLength(1);
    const only = contents[0] as TextResourceContents;
    expect(only.mimeType).toBe("image/png");
    expect(only.text).toBe("\x89PNG\r\n");
  });

  it("routes through a ResourcesHarness when registered under file://{+path}", async () => {
    const sandbox = await seededSandbox({ "/workspace/data.json": '{"ok":true}' });
    const resources = makeResources();
    registerFileResolver(resources, sandboxFileResolver(sandbox));
    const contents = await resources.read("file:///workspace/data.json");
    expect(contents).toEqual([
      { uri: "file:///workspace/data.json", mimeType: "application/json", text: '{"ok":true}' },
    ]);
  });
});

describe("fsFileResolver (ADR 65 — no-sandbox read path)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function tmpRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentick-fr-"));
    dirs.push(dir);
    return dir;
  }

  it("reads a text file as UTF-8 text contents", async () => {
    const root = await tmpRoot();
    await writeFile(join(root, "note.md"), "# hi");
    const resolver = fsFileResolver(root);
    const uri = pathToFileUri(join(root, "note.md"));
    const contents = (await resolver(uri)) as readonly TextResourceContents[];
    expect(contents[0]).toEqual({ uri, mimeType: "text/markdown", text: "# hi" });
  });

  it("reads a binary file losslessly as a base64 blob", async () => {
    const root = await tmpRoot();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await writeFile(join(root, "logo.png"), bytes);
    const resolver = fsFileResolver(root);
    const uri = pathToFileUri(join(root, "logo.png"));
    const contents = (await resolver(uri)) as readonly BlobResourceContents[];
    expect(contents[0]!.mimeType).toBe("image/png");
    expect(contents[0]!.blob).toBe(bytes.toString("base64"));
    // Round-trips losslessly.
    expect(Buffer.from(contents[0]!.blob, "base64")).toEqual(bytes);
  });

  it("rejects a path that escapes the configured root", async () => {
    const root = await tmpRoot();
    const escaping = pathToFileUri(join(root, "..", "etc-passwd"));
    const resolver = fsFileResolver(root);
    await expect(resolver(escaping)).rejects.toThrow(/escapes root/);
  });
});
