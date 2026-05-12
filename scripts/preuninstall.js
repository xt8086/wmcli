/**
 * Pre-uninstall: offer to remove taskcli config and data.
 * Runs automatically before npm uninstall.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

const CONFIG = join(homedir(), ".taskcli.json");
const DATA_DIR = join(homedir(), ".taskcli");

function remove(taskcliOnly: boolean): void {
  if (existsSync(CONFIG)) {
    rmSync(CONFIG);
    console.log("[taskcli] Removed ~/.taskcli.json");
  }
  if (!taskcliOnly && existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log("[taskcli] Removed ~/.taskcli/ (memory database)");
  }
}

// Non-interactive: check TASKCLI_UNINSTALL env var
const mode = process.env.TASKCLI_UNINSTALL;
if (mode === "full") {
  remove(false);
  console.log("[taskcli] Full uninstall complete (config + data removed).");
} else if (mode === "config") {
  remove(true);
  console.log("[taskcli] Config removed. Memory database kept at ~/.taskcli/");
} else {
  // Default: just remove config, keep data
  remove(true);
  console.log("[taskcli] Config removed. Memory database kept at ~/.taskcli/");
  console.log("[taskcli] To also remove memory data: rm -rf ~/.taskcli/");
  console.log("[taskcli] Note: API keys in ~/.pi/agent/auth.json are shared with pi and were NOT removed.");
}
