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
    packages: [
      "@agentick/sandbox",
      "@agentick/sandbox-local",
      "@agentick/sandbox-docker",
      "@agentick/sandbox-secure-exec",
    ],
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
      "@agentick/spec-next",
      "@agentick/runtime-next",
      "@agentick/app-next",
      "@agentick/session-next",
      "@agentick/reconciler-next",
      "@agentick/reconciler-react-next",
      "@agentick/executor-next",
      "@agentick/model-next",
      "@agentick/model-openai-next",
      "@agentick/model-anthropic-next",
      "@agentick/model-google-next",
      "@agentick/model-ai-sdk-next",
      "@agentick/loop-executor-next",
      "@agentick/tool-executor-next",
      "@agentick/tool-next",
      "@agentick/knobs-next",
      "@agentick/state-next",
      "@agentick/timeline-next",
      "@agentick/timeline-fs-next",
      "@agentick/timeline-postgres-next",
      "@agentick/skills-next",
      "@agentick/prompts-next",
      "@agentick/prompts-react-next",
      "@agentick/elicitation-next",
      "@agentick/resources-next",
      "@agentick/mcp-next",
      "@agentick/gates-next",
      "@agentick/formatters-next",
      "@agentick/subscriptions-next",
      "@agentick/spec-conformance-next",
      "@agentick/sandbox-next",
      "@agentick/sandbox-local-next",
      "@agentick/sandbox-docker-next",
      "@agentick/sandbox-lambda-next",
      "@agentick/credentials-next",
      "@agentick/connector-next",
      "@agentick/gateway-next",
      "@agentick/pubsub-next",
      "@agentick/cluster-next",
      "@agentick/cluster-broker-next",
      "@agentick/cluster-net-next",
      "@agentick/cluster-ws-next",
      "@agentick/cluster-redis-next",
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

  // Ignore dead links in auto-generated API docs (TypeDoc cross-references to
  // packages not included in documentation, like _media/nestjs)
  ignoreDeadLinks: [/\/_media\//, /\.md$/],

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
      { text: "API", link: "/api/" },
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
            { text: "The Reconciler", link: "/docs/reconciler" },
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
      "/api/": loadApiSidebar(),
    },

    socialLinks: [{ icon: "github", link: "https://github.com/agenticklabs/agentick" }],

    footer: {
      message: "Released under the ISC License.",
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
