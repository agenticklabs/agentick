import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { serveStatic } from "../serve-static.js";

const TEST_DIR = join(tmpdir(), `serve-static-test-${Date.now()}`);
let server: Server;
let port: number;

function makeRequest(
  path: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}${path}`;
    const req = new URL(url);
    const options: any = {
      hostname: req.hostname,
      port: req.port,
      path: req.pathname + req.search,
      method: "GET",
      headers: headers ?? {},
    };
    const http = require("node:http");
    const request = http.request(options, (res: any) => {
      let body = "";
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        const h: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          h[key] = String(val);
        }
        resolve({ status: res.statusCode, headers: h, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

beforeAll(async () => {
  // Create test directory structure
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "assets"), { recursive: true });
  mkdirSync(join(TEST_DIR, "sub"), { recursive: true });

  writeFileSync(join(TEST_DIR, "index.html"), "<html><body>Hello</body></html>");
  writeFileSync(join(TEST_DIR, "style.css"), "body { color: red; }");
  writeFileSync(join(TEST_DIR, "app.js"), "console.log('hello');");
  writeFileSync(join(TEST_DIR, "data.json"), '{"key":"value"}');
  writeFileSync(join(TEST_DIR, "assets", "logo.png"), "fake-png-data");
  writeFileSync(join(TEST_DIR, "sub", "page.html"), "<html>sub page</html>");

  const handler = serveStatic(TEST_DIR, { prefix: "/dashboard" });

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" ? addr!.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("serveStatic", () => {
  it("serves index.html at root", async () => {
    const res = await makeRequest("/dashboard/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("Hello");
  });

  it("serves CSS with correct content type", async () => {
    const res = await makeRequest("/dashboard/style.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("serves JS with correct content type", async () => {
    const res = await makeRequest("/dashboard/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/javascript; charset=utf-8");
  });

  it("serves JSON with correct content type", async () => {
    const res = await makeRequest("/dashboard/data.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("serves files in subdirectories", async () => {
    const res = await makeRequest("/dashboard/sub/page.html");
    expect(res.status).toBe(200);
    expect(res.body).toContain("sub page");
  });

  it("rejects encoded path traversal", async () => {
    // HTTP clients normalize /../ before sending, so we test with %2F encoding
    // which bypasses client-side normalization and reaches the server
    const res = await makeRequest("/dashboard/..%2F..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(403);
  });

  it("rejects double-encoded path traversal", async () => {
    const res = await makeRequest("/dashboard/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect(res.status).toBe(403);
  });

  it("returns 304 for matching ETag", async () => {
    const first = await makeRequest("/dashboard/style.css");
    expect(first.status).toBe(200);
    const etag = first.headers["etag"];
    expect(etag).toBeDefined();

    const second = await makeRequest("/dashboard/style.css", { "if-none-match": etag });
    expect(second.status).toBe(304);
  });

  it("includes Cache-Control header", async () => {
    const res = await makeRequest("/dashboard/app.js");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("SPA fallback for unknown paths", async () => {
    const res = await makeRequest("/dashboard/some/unknown/route");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Hello"); // Falls back to index.html
    // Fallback should have no-cache
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 404 when fallback is disabled and file missing", async () => {
    const handler = serveStatic(TEST_DIR, { prefix: "/nofallback", fallback: false });
    const s = createServer(async (req, res) => {
      await handler(req, res);
    });

    const p = await new Promise<number>((resolve) => {
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        resolve(typeof addr === "object" ? addr!.port : 0);
      });
    });

    try {
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const http = require("node:http");
        http
          .get(`http://127.0.0.1:${p}/nofallback/nonexistent`, (r: any) => {
            let body = "";
            r.on("data", (c: string) => (body += c));
            r.on("end", () => resolve({ status: r.statusCode }));
          })
          .on("error", reject);
      });
      expect(res.status).toBe(404);
    } finally {
      s.close();
    }
  });

  it("strips prefix correctly", async () => {
    // /dashboard/style.css → strips /dashboard → /style.css → serves TEST_DIR/style.css
    const res = await makeRequest("/dashboard/style.css");
    expect(res.status).toBe(200);
    expect(res.body).toContain("color: red");
  });
});
