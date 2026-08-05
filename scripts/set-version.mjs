import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}

for (const dir of readdirSync("packages")) {
  const manifestPath = join("packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
console.log(`set ${version} across packages/`);
