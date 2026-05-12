/**
 * Postinstall: rebuild native modules and patch pi SDK.
 * Runs automatically after npm install.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 1. Rebuild better-sqlite3 (native module must compile for this platform)
// ---------------------------------------------------------------------------
try {
  console.log("[wmcli] Rebuilding better-sqlite3 for your platform...");
  execSync("npx --yes node-gyp rebuild --directory=node_modules/better-sqlite3", {
    stdio: "pipe",
    cwd: import.meta.dirname + "/..",
  });
  console.log("[wmcli] ✅ better-sqlite3 rebuilt.");
} catch (err) {
  console.warn("[wmcli] ⚠️  better-sqlite3 rebuild failed. May need manual fix:");
  console.warn("    cd node_modules/better-sqlite3 && npx node-gyp rebuild");
}

// ---------------------------------------------------------------------------
// 2. Patch pi SDK: null-guard crashes in estimateTokens / compaction
// ---------------------------------------------------------------------------
const TARGET = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@mariozechner",
  "pi-coding-agent",
  "dist",
  "core",
  "compaction",
  "compaction.js"
);

const PATCHES = [
  {
    old: `if (typeof message.content === "string") {
                chars = message.content.length;
            }
            else {
                for (const block of message.content) {`,
    new: `if (typeof message.content === "string") {
                chars = message.content.length;
            }
            else if (message.content) {
                for (const block of message.content) {`,
    label: "toolResult null guard",
  },
  {
    old: `const assistant = message;
            for (const block of assistant.content) {`,
    new: `const assistant = message;
            if (!assistant.content) return 0;
            for (const block of assistant.content) {`,
    label: "assistant null guard",
  },
];

if (existsSync(TARGET)) {
  try {
    let content = readFileSync(TARGET, "utf-8");

    for (const patch of PATCHES) {
      if (content.includes(patch.new)) {
        // Already patched
      } else if (content.includes(patch.old)) {
        content = content.replace(patch.old, patch.new);
        console.log(`[wmcli] Patched pi SDK: ${patch.label}`);
      } else {
        console.warn(`[wmcli] WARNING: patch target "${patch.label}" not found. SDK may have changed.`);
      }
    }

    writeFileSync(TARGET, content, "utf-8");
  } catch (err) {
    console.warn(`[wmcli] Failed to patch pi SDK: ${err.message}`);
  }
} else {
  console.warn("[wmcli] pi SDK compaction.js not found — skipping patch.");
}
