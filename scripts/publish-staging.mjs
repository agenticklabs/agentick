import { execFileSync, execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DOMAIN = "knowify";
const OWNER = "785109749066";
const REGION = "us-east-1";
const REPO = "knowifyinc";
const HOST = `${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com`;
const REGISTRY = `https://${HOST}/npm/${REPO}/`;

// v2 names that also exist on npmjs as v1 0.15.x; both origins must stay open
// while v1 remains in the staging dependency graph.
const COLLISION_NAMES = [
  "mcp",
  "gateway",
  "eval",
  "sandbox",
  "sandbox-docker",
  "sandbox-local",
  "client",
  "connector",
];

const aws = (args) =>
  execFileSync("aws", [
    "codeartifact",
    ...args,
    "--domain",
    DOMAIN,
    "--domain-owner",
    OWNER,
    "--region",
    REGION,
  ])
    .toString()
    .trim();

function allowBothOrigins(label) {
  for (const name of COLLISION_NAMES) {
    try {
      aws([
        "put-package-origin-configuration",
        "--repository",
        REPO,
        "--format",
        "npm",
        "--namespace",
        "agentick",
        "--package",
        name,
        "--restrictions",
        "publish=ALLOW,upstream=ALLOW",
      ]);
      console.log(`origin-config (${label}): @agentick/${name} -> publish=ALLOW,upstream=ALLOW`);
    } catch {
      console.log(`origin-config (${label}): @agentick/${name} not in repo yet, skipping`);
    }
  }
}

async function registryFetch(token, pkg) {
  const res = await fetch(`${REGISTRY}${encodeURIComponent(pkg)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok ? res.json() : null;
}

const version = JSON.parse(readFileSync("packages/spec/package.json", "utf8")).version;
const token = aws(["get-authorization-token", "--query", "authorizationToken", "--output", "text"]);

const already = await registryFetch(token, "@agentick/spec");
if (already?.versions?.[version] && !process.env.RESUME) {
  console.error(
    `@agentick/spec@${version} already in ${REPO} — bump the version first (RESUME=1 to republish stragglers)`,
  );
  process.exit(1);
}

allowBothOrigins("pre-publish");

execSync("pnpm verify:publish", { stdio: "inherit" });

// The scoped registry MUST ride the CLI. An `npm_config_@agentick:registry`
// env var does NOT outrank the project .npmrc's `@agentick:registry` line, and
// a plain `--registry` loses to a scope entry for a scoped package — so both
// earlier forms silently published all 59 packages to verdaccio instead. The
// token stays in the environment: a command line is world-readable in `ps`.
execSync(`pnpm publish -r --no-git-checks --tag next --config.@agentick:registry=${REGISTRY}`, {
  stdio: "inherit",
  env: {
    ...process.env,
    [`npm_config_//${HOST}/npm/${REPO}/:_authToken`]: token,
  },
});

allowBothOrigins("post-publish");

let failures = 0;
for (const dir of readdirSync("packages")) {
  const manifestPath = join("packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) continue;
  const published = await registryFetch(token, manifest.name);
  if (!published?.versions?.[version]) {
    console.error(`MISSING: ${manifest.name}@${version} not in ${REPO}`);
    failures++;
  }
}

const v1Gateway = await registryFetch(token, "@agentick/gateway");
if (!v1Gateway?.versions?.["0.15.3"]) {
  console.error("MISSING: @agentick/gateway@0.15.3 no longer resolvable — v1 upstream is broken");
  failures++;
}

if (failures) process.exit(1);
console.log(`\nAll publishable packages verified at ${version} in ${REPO}; v1 upstream intact.`);
