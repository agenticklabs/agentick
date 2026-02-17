/**
 * Postinstall script — compiles the Swift bridge binary.
 *
 * Skips gracefully on non-macOS or when swiftc is unavailable.
 * The compiled binary lands in bin/apple-fm-bridge, which package.json
 * registers via "bin" so it ends up in node_modules/.bin/.
 */

import { execSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const swiftSource = join(packageRoot, "inference.swift");
const binDir = join(packageRoot, "bin");
const outputBinary = join(binDir, "apple-fm-bridge");

// Only compile on macOS
if (process.platform !== "darwin") {
  console.log("[@agentick/apple] Skipping — not macOS");
  process.exit(0);
}

// Check for swiftc
try {
  execSync("which swiftc", { stdio: "ignore" });
} catch {
  console.log("[@agentick/apple] Skipping — swiftc not found (install Xcode)");
  process.exit(0);
}

// Check source exists
if (!existsSync(swiftSource)) {
  console.log("[@agentick/apple] Skipping — inference.swift not found");
  process.exit(0);
}

// Skip if binary already exists and is newer than source
if (existsSync(outputBinary)) {
  const srcTime = statSync(swiftSource).mtimeMs;
  const binTime = statSync(outputBinary).mtimeMs;
  if (binTime > srcTime) {
    console.log("[@agentick/apple] Bridge binary up to date");
    process.exit(0);
  }
}

mkdirSync(binDir, { recursive: true });

console.log("[@agentick/apple] Compiling Swift bridge...");

try {
  execSync(
    `swiftc -parse-as-library -framework FoundationModels -O "${swiftSource}" -o "${outputBinary}"`,
    { stdio: "inherit" },
  );
  console.log("[@agentick/apple] Bridge compiled → bin/apple-fm-bridge");
} catch {
  // Non-fatal — the package still installs, just can't run inference
  console.warn("[@agentick/apple] Swift compilation failed (macOS 26+ with Xcode required)");
}
