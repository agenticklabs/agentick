import { defineConfig } from "vitepress";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Package grouping for API sidebar
const PACKAGE_GROUPS: Array<{ label: string; packages: string[] }> = [
  {
    label: "Core",
    packages: ["@agentick/core", "@agentick/kernel", "@agentick/shared"],
  },
  {
    label: "Agent",
    packages: [
      "@agentick/agent",
      "@agentick/guardrails",
      "@agentick/scheduler",
      "@agentick/secrets",
    ],
  },
  {
    label: "Adapters",
    packages: ["@agentick/openai", "@agentick/google", "@agentick/ai-sdk", "@agentick/apple"],
  },
  {
    label: "Server",
    packages: [
      "@agentick/gateway",
      "@agentick/server",
      "@agentick/express",
      "@agentick/nestjs",
      "@agentick/mcp",
    ],
  },
  {
    label: "Client",
    packages: [
      "@agentick/client",
      "@agentick/react",
      "@agentick/angular",
      "@agentick/cli",
      "@agentick/tui",
      "@agentick/client-multiplexer",
    ],
  },
  {
    label: "Sandbox",
    packages: ["@agentick/sandbox", "@agentick/sandbox-local", "@agentick/sandbox-docker"],
  },
  {
    label: "Connectors",
    packages: [
      "@agentick/connector",
      "@agentick/connector-imessage",
      "@agentick/connector-telegram",
    ],
  },
  {
    label: "DevTools",
    packages: ["@agentick/devtools"],
  },
  {
    label: "v2 (work in progress) — `-next` suffix during migration",
    packages: [
      "@agentick/spec",
      "@agentick/runtime",
      "@agentick/app",
      "@agentick/session",
      "@agentick/compiler",
      "@agentick/compiler-react",
      "@agentick/model-executor",
      "@agentick/model",
      "@agentick/model-openai",
      "@agentick/model-anthropic",
      "@agentick/model-google",
      "@agentick/model-ai-sdk",
      "@agentick/loop-executor",
      "@agentick/tool-executor",
      "@agentick/tool",
      "@agentick/knobs",
      "@agentick/state",
      "@agentick/timeline",
      "@agentick/timeline-fs",
      "@agentick/timeline-postgres",
      "@agentick/tasks-store-postgres",
      "@agentick/skills",
      "@agentick/completions",
      "@agentick/prompts",
      "@agentick/prompts-react",
      "@agentick/client-react",
      "@agentick/elicitation",
      "@agentick/resources",
      "@agentick/live",
      "@agentick/mcp",
      "@agentick/gates",
      "@agentick/formatters",
      "@agentick/subscriptions",
      "@agentick/spec-conformance",
      "@agentick/code",
      "@agentick/code-host",
      "@agentick/code-secure-exec",
      "@agentick/sandbox",
      "@agentick/sandbox-local",
      "@agentick/sandbox-docker",
      "@agentick/sandbox-lambda",
      "@agentick/credentials",
      "@agentick/telemetry-otlp",
      "@agentick/connector",
      "@agentick/gateway",
      "@agentick/pubsub",
      "@agentick/store",
      "@agentick/cluster",
      "@agentick/cluster-broker",
      "@agentick/cluster-net",
      "@agentick/cluster-ws",
      "@agentick/cluster-redis",
    ],
  },
];

// Load TypeDoc-generated sidebar if it exists
function loadApiSidebar() {
  const sidebarPath = resolve(__dirname, "../api/typedoc-sidebar.json");
  if (!existsSync(sidebarPath)) return [];

  const raw = JSON.parse(readFileSync(sidebarPath, "utf-8"));

  // Strip .md extensions from links for clean URLs
  function stripMd(items: any[]): any[] {
    return items.map((item) => ({
      ...item,
      link: item.link?.replace(/\.md$/, ""),
      items: item.items ? stripMd(item.items) : undefined,
    }));
  }

  const cleaned = stripMd(raw);

  // Build a map of package name → sidebar item
  const itemMap = new Map<string, any>();
  for (const item of cleaned) {
    itemMap.set(item.text, item);
  }

  // Group into sections
  const grouped: any[] = [];
  const placed = new Set<string>();

  for (const group of PACKAGE_GROUPS) {
    const items: any[] = [];
    for (const pkg of group.packages) {
      const item = itemMap.get(pkg);
      if (item) {
        items.push(item);
        placed.add(pkg);
      }
    }
    if (items.length > 0) {
      grouped.push({
        text: group.label,
        collapsed: false,
        items,
      });
    }
  }

  // Catch any ungrouped packages
  for (const item of cleaned) {
    if (!placed.has(item.text)) {
      grouped.push(item);
    }
  }

  return grouped;
}

export default defineConfig({
  title: "agentick",
  description: "The component framework for AI.",
  base: "/agentick/",

  // _media holds files README doc-links pointed at (internal design docs,
  // STATUS logs). They are link targets, not pages — compiling them as pages
  // is what let a raw `{{` inside an internal log kill the whole build.
  srcExclude: ["api/_media/**"],

  // Ignore dead links in auto-generated API docs (TypeDoc cross-references to
  // packages not included in documentation, like _media/nestjs)
  ignoreDeadLinks: [
    /\/_media\//,
    /\.md$/,
    /\.\.\/[a-z0-9-]+\/?(index)?(#.*)?$/,
    // Intra-package source-dir links in READMEs (`./src/server`).
    /^\.\/src\//,
    // v1-era API references in legacy prose docs — the docs content is being
    // rewritten wholesale for v2; these pages go with it.
    /\/api\/@agentick\/core\//,
  ],

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/agentick/logo.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "agentick" }],
    ["meta", { property: "og:title", content: "agentick — the component framework for AI" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "React, but the render target is model context instead of DOM. Build AI applications with the tools you already know.",
      },
    ],
    ["meta", { property: "og:url", content: "https://agenticklabs.github.io/agentick/" }],
    [
      "meta",
      {
        property: "og:image",
        content: "https://agenticklabs.github.io/agentick/og-image.png",
      },
    ],
    ["meta", { property: "og:image:type", content: "image/png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "agentick — the component framework for AI",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "agentick — the component framework for AI" }],
    [
      "meta",
      {
        name: "twitter:description",
        content:
          "React, but the render target is model context instead of DOM. Build AI applications with the tools you already know.",
      },
    ],
    [
      "meta",
      {
        name: "twitter:image",
        content: "https://agenticklabs.github.io/agentick/og-image.png",
      },
    ],
    [
      "meta",
      {
        name: "twitter:image:alt",
        content: "agentick — the component framework for AI",
      },
    ],
  ],

  themeConfig: {
    logo: "/logo.svg",

    nav: [
      { text: "Docs", link: "/docs/getting-started" },
      { text: "v2 (preview)", link: "/docs/v2/" },
      { text: "API", link: "/api/" },
      { text: "Blog", link: "/blog/" },
      {
        text: "GitHub",
        link: "https://github.com/agenticklabs/agentick",
      },
    ],

    sidebar: {
      "/docs/": [
        {
          text: "Introduction",
          items: [
            { text: "What is agentick?", link: "/docs/what-is-agentick" },
            { text: "Getting Started", link: "/docs/getting-started" },
            { text: "Why JSX?", link: "/docs/why-jsx" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            {
              text: "Sessions & Execution",
              link: "/docs/sessions-and-execution",
            },
            { text: "Agent Harness", link: "/docs/agent-harness" },
            { text: "The Compiler", link: "/docs/compiler" },
            { text: "Components & JSX", link: "/docs/components" },
            { text: "Hooks", link: "/docs/hooks" },
            { text: "Tools", link: "/docs/tools" },
            { text: "Skills", link: "/docs/skills" },
            { text: "Timeline", link: "/docs/timeline" },
            { text: "Procedures", link: "/docs/procedures" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Your First Agent", link: "/docs/first-agent" },
            { text: "Adding Tools", link: "/docs/adding-tools" },
            { text: "Stateful Tools", link: "/docs/stateful-tools" },
            { text: "Multi-turn Conversations", link: "/docs/multi-turn" },
            { text: "Knobs & Controls", link: "/docs/knobs" },
            { text: "Gates", link: "/docs/gates" },
            { text: "Model Adapters", link: "/docs/adapters" },
            { text: "Custom Blocks", link: "/docs/custom-blocks" },
            { text: "Sandbox", link: "/docs/sandbox" },
            { text: "Terminal UI (TUI)", link: "/docs/tui" },
            { text: "Testing", link: "/docs/testing" },
            { text: "Evals", link: "/docs/evals" },
          ],
        },
        {
          text: "Patterns",
          items: [{ text: "Expandable Context", link: "/docs/patterns/expandable-context" }],
        },
        {
          text: "Architecture",
          items: [
            { text: "Package Overview", link: "/docs/packages" },
            { text: "Gateway & Sessions", link: "/docs/gateway" },
            { text: "Gateway Protocol", link: "/docs/gateway-protocol" },
            { text: "Client-Server", link: "/docs/client-server" },
            { text: "Connectors", link: "/docs/connectors" },
            { text: "Observability", link: "/docs/observability" },
            { text: "DevTools", link: "/docs/devtools" },
          ],
        },
      ],
      "/docs/v2/": [
        {
          text: "v2 Preview (work in progress)",
          items: [{ text: "Overview", link: "/docs/v2/" }],
        },
        {
          text: "MCP & Resources",
          items: [
            { text: "Resources", link: "/docs/v2/resources" },
            { text: "MCP: Connecting to Servers", link: "/docs/v2/mcp" },
            { text: "Exposing an MCP Server", link: "/docs/v2/mcp-server" },
          ],
        },
      ],
      "/api/": loadApiSidebar(),
    },

    socialLinks: [{ icon: "github", link: "https://github.com/agenticklabs/agentick" }],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright 2025-present Ryan Lindgren",
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/agenticklabs/agentick/edit/master/website/:path",
    },
  },
});
