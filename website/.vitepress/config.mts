import { defineConfig } from "vitepress";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

  return stripMd(raw);
}

export default defineConfig({
  title: "agentick",
  description: "Build agents like you build apps.",
  base: "/agentick/",

  // Ignore dead links in auto-generated API docs (TypeDoc cross-references to
  // packages not included in documentation, like _media/nestjs)
  ignoreDeadLinks: [/\/_media\//, /\.md$/],

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/agentick/logo.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "agentick" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Build agents like you build apps.",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "agentick" }],
    [
      "meta",
      {
        name: "twitter:description",
        content: "Build agents like you build apps.",
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
            { text: "The Reconciler", link: "/docs/reconciler" },
            { text: "Components & JSX", link: "/docs/components" },
            { text: "Hooks", link: "/docs/hooks" },
            { text: "Tools", link: "/docs/tools" },
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
            { text: "Model Adapters", link: "/docs/adapters" },
            { text: "Testing", link: "/docs/testing" },
          ],
        },
        {
          text: "Architecture",
          items: [
            { text: "Package Overview", link: "/docs/packages" },
            { text: "Gateway & Sessions", link: "/docs/gateway" },
            { text: "Client-Server", link: "/docs/client-server" },
            { text: "DevTools", link: "/docs/devtools" },
          ],
        },
      ],
      "/api/": loadApiSidebar(),
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/agenticklabs/agentick" },
    ],

    footer: {
      message: "Released under the ISC License.",
      copyright: "Copyright 2025-present Ryan Lindgren",
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/agenticklabs/agentick/edit/master/website/:path",
    },
  },
});
