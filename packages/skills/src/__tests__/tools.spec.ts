/**
 * `skill_list` / `skill_read` model tools + `withSkills` registration.
 * Handlers reach the skills harness via `ctx.skills` — exercised here
 * against a REAL {@link SkillsHarness}.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ContentBlock,
  SessionInstaller,
  Skills,
  ToolHandlerCtx,
  ToolRegistration,
} from "@agentick/spec";

import { SkillsHarness } from "../harness.js";
import { withSkills } from "../extension.js";
import { buildSkillsTools, SKILL_LIST, SKILL_READ } from "../tools.js";

async function harnessWith(): Promise<SkillsHarness> {
  const h = new SkillsHarness("st", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  await h.ready;
  await h.register({
    name: "greeting",
    description: "How to greet the user",
    content: "# Greeting\nAlways say hello warmly.",
    tags: ["social"],
  });
  await h.register({
    name: "farewell",
    description: "How to end a conversation",
    content: "# Farewell\nSign off politely.",
  });
  return h;
}

function ctxWith(skills: Skills | undefined): ToolHandlerCtx {
  return { skills } as unknown as ToolHandlerCtx;
}

describe("skill_list / skill_read handlers", () => {
  it("skill_list enumerates registered skills (name + description + tags)", async () => {
    const skills = await harnessWith();
    const { handlers } = buildSkillsTools("s1");
    const listHandler = handlers.find((h) => h.handlerRef.endsWith(":list"))!.handler;

    const blocks = (await listHandler(
      {},
      { ctx: ctxWith(skills), use: {} },
    )) as readonly ContentBlock[];
    const payload = JSON.parse((blocks[0] as { text: string }).text);
    // The harness's `list()` is name-sorted, not insertion-ordered.
    expect(payload.skills).toEqual([
      { name: "farewell", description: "How to end a conversation" },
      { name: "greeting", description: "How to greet the user", tags: ["social"] },
    ]);
  });

  it("skill_read returns the skill's full content + metadata", async () => {
    const skills = await harnessWith();
    const { handlers } = buildSkillsTools("s2");
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    const blocks = (await readHandler(
      { name: "greeting" },
      { ctx: ctxWith(skills), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual({
      name: "greeting",
      description: "How to greet the user",
      content: "# Greeting\nAlways say hello warmly.",
      tags: ["social"],
    });
  });

  it("skill_read degrades honestly on an unknown name", async () => {
    const skills = await harnessWith();
    const { handlers } = buildSkillsTools("s3");
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    const blocks = (await readHandler(
      { name: "nope" },
      { ctx: ctxWith(skills), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual({
      error: "skill_not_found",
      name: "nope",
    });
  });

  it("degrades honestly when no skills harness is present", async () => {
    const { handlers } = buildSkillsTools("s4");
    const listHandler = handlers.find((h) => h.handlerRef.endsWith(":list"))!.handler;
    const readHandler = handlers.find((h) => h.handlerRef.endsWith(":read"))!.handler;

    const listBlocks = (await listHandler(
      {},
      { ctx: ctxWith(undefined), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((listBlocks[0] as { text: string }).text)).toEqual({ skills: [] });

    const readBlocks = (await readHandler(
      { name: "greeting" },
      { ctx: ctxWith(undefined), use: {} },
    )) as readonly ContentBlock[];
    expect(JSON.parse((readBlocks[0] as { text: string }).text)).toMatchObject({
      error: "skills_unavailable",
    });
  });
});

describe("withSkills — tool registration", () => {
  function fakeInstaller(): {
    installer: SessionInstaller;
    tools: ToolRegistration[];
    handlerRefs: string[];
    namespaces: string[];
  } {
    const tools: ToolRegistration[] = [];
    const handlerRefs: string[] = [];
    const namespaces: string[] = [];
    const installer = {
      sessionId: "sess",
      hostId: "sess",
      substrate: {
        journal: new MemoryJournal(),
        bus: new LocalEventBus(),
        inbox: new LocalInbox(),
      },
      interceptors: {},
      getNamespace: () => undefined,
      registerNamespace: (name: string) => {
        namespaces.push(name);
        return () => {};
      },
      registerToolHandler: (ref: string) => {
        handlerRefs.push(ref);
        return () => {};
      },
      registerExtensionTool: (reg: ToolRegistration) => {
        tools.push(reg);
        return () => {};
      },
      onClose: () => {},
    } as unknown as SessionInstaller;
    return { installer, tools, handlerRefs, namespaces };
  }

  it("registers skill_list + skill_read by default (live-instance arm)", async () => {
    const inst = new SkillsHarness(
      "i1",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await inst.ready;
    const { installer, tools, handlerRefs } = fakeInstaller();
    // The dichotomy's second arm: the instance is passed DIRECTLY, not nested
    // under a `use:` key (ADR 93 §Composition ruling).
    const ext = withSkills(inst);
    await ext.install(installer);
    expect(tools.map((t) => t.declaration.name).sort()).toEqual([SKILL_LIST, SKILL_READ]);
    expect(handlerRefs).toHaveLength(2);
  });

  it("registers skill_list + skill_read by default (definition arm)", async () => {
    const { installer, tools, handlerRefs } = fakeInstaller();
    await withSkills({}).install(installer);
    expect(tools.map((t) => t.declaration.name).sort()).toEqual([SKILL_LIST, SKILL_READ]);
    expect(handlerRefs).toHaveLength(2);
  });

  it("registerModelTools:false suppresses the model tools", async () => {
    const { installer, tools, handlerRefs, namespaces } = fakeInstaller();
    await withSkills({ registerModelTools: false }).install(installer);
    expect(tools).toHaveLength(0);
    expect(handlerRefs).toHaveLength(0);
    // The namespace is still published — the substrate exists, only the
    // model surface is suppressed.
    expect(namespaces).toEqual(["skills"]);
  });
});
