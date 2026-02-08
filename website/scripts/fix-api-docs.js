import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const API_DIR = resolve(import.meta.dirname, "../api");
const PROCESSED_MARKER = "<!-- PROCESSED -->";

// Standard HTML5 void and common elements that Vue/VitePress should handle
const HTML_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio",
  "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button",
  "canvas", "caption", "cite", "code", "col", "colgroup",
  "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
  "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
  "i", "iframe", "img", "input", "ins",
  "kbd",
  "label", "legend", "li", "link",
  "main", "map", "mark", "menu", "meta", "meter",
  "nav", "noscript",
  "object", "ol", "optgroup", "option", "output",
  "p", "param", "picture", "pre", "progress",
  "q",
  "rp", "rt", "ruby",
  "s", "samp", "script", "section", "select", "slot", "small", "source", "span",
  "strong", "style", "sub", "summary", "sup",
  "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "title", "tr", "track",
  "u", "ul",
  "var", "video",
  "wbr",
  // SVG common
  "svg", "path", "circle", "rect", "line", "polygon", "polyline", "text", "g",
  // Vue/VitePress special
  "v-pre", "ClientOnly", "Badge",
]);

function escapeNonHtmlTags(text) {
  // Match opening tags: <Word...>, <Word />, <Word attr="val">
  // Match closing tags: </Word>
  // Only keep tags that are EXACTLY lowercase standard HTML.
  // PascalCase like <Section>, <Message>, <Timeline> must be escaped —
  // Vue treats those as component references and will infinite-loop or error.
  return text.replace(
    /<(\/?)([\w.-]+)([\s>\/])/g,
    (match, slash, tagName, after) => {
      // Only preserve if tag name is EXACTLY in the HTML set (case-sensitive)
      if (HTML_TAGS.has(tagName)) {
        return match; // Keep valid HTML
      }
      return `&lt;${slash}${tagName}${after}`;
    },
  );
}

function processFile(filePath) {
  let content = readFileSync(filePath, "utf-8");

  // Skip already-processed files
  if (content.includes(PROCESSED_MARKER)) return;

  // Separate frontmatter from body
  let frontmatter = "";
  let body = content;

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      frontmatter = content.slice(0, endIdx + 3);
      body = content.slice(endIdx + 3);
      frontmatter = frontmatter.replace(/^---\n/, "---\neditLink: false\n");
    }
  } else {
    frontmatter = "---\neditLink: false\n---";
  }

  // Process body: split by code blocks and inline code, only escape non-code parts
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    // Escape non-HTML tags (TypeScript generics, JSX components, etc.)
    parts[i] = escapeNonHtmlTags(parts[i]);
    // Escape double curly braces (Vue template interpolation)
    parts[i] = parts[i].replace(/\{\{/g, "&#123;&#123;");
    parts[i] = parts[i].replace(/\}\}/g, "&#125;&#125;");
  }
  body = parts.join("");

  // Marker goes AFTER frontmatter — VitePress requires --- to be the first line
  content = `${frontmatter}\n${PROCESSED_MARKER}\n${body}`;
  writeFileSync(filePath, content);
}

function processDirectory(dirPath) {
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.endsWith(".md")) {
      processFile(fullPath);
    }
  }
}

function replaceIndex(apiDir) {
  const indexPath = join(apiDir, "index.md");
  writeFileSync(
    indexPath,
    `---
editLink: false
---
${PROCESSED_MARKER}

# API Reference

Auto-generated API documentation for all agentick packages.

Browse the sidebar to explore types, functions, and classes from each package.

## Packages

| Package | Description |
|---------|-------------|
| [@agentick/core](./@agentick/core/) | Reconciler, hooks, JSX, compiler |
| [@agentick/kernel](./@agentick/kernel/) | Procedures, execution, context |
| [@agentick/shared](./@agentick/shared/) | Wire types, blocks, messages |
| [@agentick/gateway](./@agentick/gateway/) | Multi-session management |
| [@agentick/client](./@agentick/client/) | Browser/Node client |
| [@agentick/server](./@agentick/server/) | Transport server |
| [@agentick/express](./@agentick/express/) | Express.js integration |
| [@agentick/react](./@agentick/react/) | React hooks & components |
| [@agentick/devtools](./@agentick/devtools/) | Inspector & debugging |
| [@agentick/agent](./@agentick/agent/) | High-level agent factory |
| [@agentick/guardrails](./@agentick/guardrails/) | Guard system |
| [@agentick/openai](./@agentick/openai/) | OpenAI adapter |
| [@agentick/google](./@agentick/google/) | Google Gemini adapter |
| [@agentick/ai-sdk](./@agentick/ai-sdk/) | Vercel AI SDK adapter |
`,
  );
}

try {
  console.log("Processing API docs...");
  replaceIndex(API_DIR);
  processDirectory(API_DIR);
  console.log("Done.");
} catch (err) {
  if (err.code === "ENOENT") {
    console.log("No API directory found — run typedoc first.");
  } else {
    throw err;
  }
}
