/**
 * Publish the workspace to one or more registries from ONE set of tarballs.
 *
 * `pnpm pack` is not byte-reproducible: rewriting `workspace:*` to a concrete
 * version reorders the dependency KEYS between runs, so two packs of identical
 * source yield different sha512s. Publishing per-registry therefore put two
 * distinct byte streams under one version, and a consumer's lockfile — which
 * pins integrity but not a registry — could only ever install from whichever
 * one it was resolved against.
 *
 * So: pack once into `.artifacts/<version>/`, upload that artifact to every
 * target, and refuse to publish a version a registry already holds under a
 * DIFFERENT integrity.
 *
 *   node scripts/publish.mjs verdaccio
 *   node scripts/publish.mjs staging
 *   node scripts/publish.mjs verdaccio staging
 *
 * `RESUME=1` re-attempts a partially-published version.
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DOMAIN = "knowify";
const OWNER = "785109749066";
const REGION = "us-east-1";
const REPO = "knowifyinc";
const CODEARTIFACT_HOST = `${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com`;
const CODEARTIFACT_REGISTRY = `https://${CODEARTIFACT_HOST}/npm/${REPO}/`;
const VERDACCIO_REGISTRY = "http://localhost:4873/";

const DIST_TAG = "next";
const ARTIFACT_ROOT = ".artifacts";

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

function publishablePackages() {
  const packages = [];
  for (const dir of readdirSync("packages")) {
    const manifestPath = join("packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private) continue;
    packages.push({ name: manifest.name, dir: join("packages", dir) });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** npm's `dist.integrity` format, computed over the exact bytes we will upload. */
function integrityOf(tarball) {
  return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

function tarballPath(artifactDir, name, version) {
  return join(artifactDir, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
}

function packAll(packages, artifactDir, version, verify) {
  execSync(verify ? "pnpm verify:publish" : "pnpm turbo build --filter './packages/*'", {
    stdio: "inherit",
  });
  mkdirSync(artifactDir, { recursive: true });
  const destination = resolve(artifactDir);
  for (const pkg of packages) {
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: pkg.dir,
      stdio: "pipe",
    });
    const tarball = tarballPath(artifactDir, pkg.name, version);
    if (!existsSync(tarball)) throw new Error(`pack produced no ${tarball}`);
  }
  console.log(`packed ${packages.length} tarballs into ${artifactDir}`);
}

async function fetchVersion(target, token, name, version) {
  const res = await fetch(`${target.registry}${encodeURIComponent(name)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  const packument = await res.json();
  return packument?.versions?.[version] ?? null;
}

function publishTarball(target, token, tarball) {
  // The scoped registry MUST ride the CLI: a plain `--registry` loses to the
  // project .npmrc's `@agentick:registry` line for a scoped package, which is
  // how an earlier run published all 59 packages to the wrong host. The token
  // stays in the environment — a command line is world-readable in `ps`.
  execFileSync(
    "npm",
    ["publish", tarball, "--tag", DIST_TAG, `--@agentick:registry=${target.registry}`],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...(target.tokenHost ? { [`npm_config_//${target.tokenHost}:_authToken`]: token } : {}),
      },
    },
  );
}

const TARGETS = {
  verdaccio: { name: "verdaccio", registry: VERDACCIO_REGISTRY },
  staging: {
    name: "staging",
    registry: CODEARTIFACT_REGISTRY,
    tokenHost: `${CODEARTIFACT_HOST}/npm/${REPO}/`,
    authToken: () =>
      aws(["get-authorization-token", "--query", "authorizationToken", "--output", "text"]),
    beforePublish: () => allowBothOrigins("pre-publish"),
    afterPublish: async (token) => {
      allowBothOrigins("post-publish");
      const v1Gateway = await fetchVersion(TARGETS.staging, token, "@agentick/gateway", "0.15.3");
      if (!v1Gateway) throw new Error("@agentick/gateway@0.15.3 unresolvable — v1 upstream broken");
    },
  },
};

const selected = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (selected.length === 0 || selected.some((t) => !TARGETS[t])) {
  console.error(`usage: node scripts/publish.mjs <${Object.keys(TARGETS).join("|")}>...`);
  process.exit(1);
}
const verify = selected.includes("staging") || process.argv.includes("--verify");

const version = JSON.parse(readFileSync("packages/spec/package.json", "utf8")).version;
const packages = publishablePackages();
const artifactDir = join(ARTIFACT_ROOT, version);

const packed = packages.every((p) => existsSync(tarballPath(artifactDir, p.name, version)));
if (packed) {
  console.log(`reusing ${artifactDir} — a version's bytes are fixed once packed`);
} else {
  packAll(packages, artifactDir, version, verify);
}

let failures = 0;
for (const key of selected) {
  const target = TARGETS[key];
  const token = target.authToken?.();
  await target.beforePublish?.(token);

  console.log(`\n=== ${target.name} (${target.registry}) ===`);
  for (const pkg of packages) {
    const tarball = tarballPath(artifactDir, pkg.name, version);
    const local = integrityOf(tarball);
    const remote = await fetchVersion(target, token, pkg.name, version);

    if (remote?.dist?.integrity === local) {
      console.log(`  = ${pkg.name}@${version} already present, identical`);
      continue;
    }
    if (remote) {
      // The failure this script exists to prevent: one version, two byte
      // streams, and a consumer lockfile that can only satisfy one of them.
      console.error(`  ! ${pkg.name}@${version} DIVERGENT — bump the version`);
      console.error(`      remote ${remote.dist?.integrity}`);
      console.error(`      local  ${local}`);
      failures++;
      continue;
    }
    publishTarball(target, token, tarball);
  }

  await target.afterPublish?.(token);
}

if (failures) process.exit(1);
console.log(`\n${version} published to ${selected.join(" + ")} from ${artifactDir}`);
