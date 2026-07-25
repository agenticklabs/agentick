/**
 * `resource_list` / `resource_read` model tools + `withResources`
 * registration. Handlers reach the resources harness via `ctx.resource`
 * — exercised here against a REAL {@link ResourcesHarness}.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ContentBlock,
  SessionInstaller,
  ToolHandlerCtx,
  ToolRegistration,
} from "@agentick/spec";

import { ResourcesHarness } from "../harness.js";
import { withResources } from "../extension.js";
import { buildResourcesTools, RESOURCE_LIST, RESOURCE_READ } from "../tools.js";

async function harnessWith(): Promise<ResourcesHarness> {
  const h = new ResourcesHarness("rt", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  await h.ready;
  h.register("config://app", () => [{ uri: "config://app", text: "cfg" }], {
    name: "App config",
    description: "Runtime configuration",
    mimeType: "application/json",
  });
  h.registerTemplate("file://{name}", (uri) => [{ uri, text: `body:${uri}` }], {
    name: "Files",
  });
  return h;
}

function ctxWith(resource: ResourcesHarness | undefined): ToolHandlerCtx {
  return { resource } as unknown as ToolHandlerCtx;
}

describe("resource_list / resource_read handlers", () => {
  it("resource_list enumerates fixed resources + templates", async () => {
    const resource = await harnessWith();
    const { handlers } = buildResourcesTools("s1");
    const listHandler = handlers.find((h) => h.handlerRef.endsWith(":list"))!.handler;

    const blocks = (await listHandler(
      {},
      { ctx: ctxWith(resource), use: {} },
    )) as readonly ContentBlock[];
    const payload = JSON.parse((blocks[0] as { text: string }).text);
    expect(payload.resources).toEqual([
      {
        uri: "config://app",
        name: "App config",
        description: "Runtime configuration",
        mimeType: "application/json",
      },
    ]);
    expect(payload.templates).toEqual([{ uriTemplate: "file://{name}", name: "Files" }]);
  });

  it("resource_read returns first-class resource content blocks", async () => {
    const resource = await harnessWith();
    const { handlers } = buildResourcesTools("s2");
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    const blocks = (await readHandler(
      { uri: "config://app" },
      { ctx: ctxWith(resource), use: {} },
    )) as readonly ContentBlock[];
    expect(blocks).toEqual([{ type: "resource", resource: { uri: "config://app", text: "cfg" } }]);
  });

  it("resource_read surfaces the harness's typed error (not a silent empty)", async () => {
    const resource = await harnessWith();
    const { handlers } = buildResourcesTools("s3");
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    await expect(
      readHandler({ uri: "missing://nope" }, { ctx: ctxWith(resource), use: {} }),
    ).rejects.toMatchObject({ _tag: "ResourceNotFound" });
  });

  it("degrades honestly when no resources harness is present", async () => {
    const { handlers } = buildResourcesTools("s4");
    const listHandler = handlers.find((h) => h.handlerRef.endsWith(":list"))!.handler;
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    const listBlocks = (await listHandler(
      {},
      { ctx: ctxWith(undefined), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((listBlocks[0] as { text: string }).text)).toEqual({ resources: [] });

    const readBlocks = (await readHandler(
      { uri: "config://app" },
      { ctx: ctxWith(undefined), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((readBlocks[0] as { text: string }).text)).toMatchObject({
      error: "resources_unavailable",
    });
  });
});

describe("withResources — tool registration", () => {
  function fakeInstaller(): {
    installer: SessionInstaller;
    tools: ToolRegistration[];
    handlerRefs: string[];
  } {
    const tools: ToolRegistration[] = [];
    const handlerRefs: string[] = [];
    const installer = {
      sessionId: "sess",
      registerToolHandler: (ref: string) => {
        handlerRefs.push(ref);
        return () => {};
      },
      registerExtensionTool: (reg: ToolRegistration) => {
        tools.push(reg);
        return () => {};
      },
    } as unknown as SessionInstaller;
    return { installer, tools, handlerRefs };
  }

  it("registers resource_list + resource_read by default", () => {
    const { installer, tools, handlerRefs } = fakeInstaller();
    const ext = withResources();
    void ext.install(installer);
    expect(tools.map((t) => t.declaration.name).sort()).toEqual([RESOURCE_LIST, RESOURCE_READ]);
    expect(handlerRefs).toHaveLength(2);
  });

  it("registerModelTools:false suppresses the model tools", () => {
    const { installer, tools, handlerRefs } = fakeInstaller();
    const ext = withResources({ registerModelTools: false });
    void ext.install(installer);
    expect(tools).toHaveLength(0);
    expect(handlerRefs).toHaveLength(0);
  });
});
