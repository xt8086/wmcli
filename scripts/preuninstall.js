/**
 * Pre-uninstall: offer to remove wmcli config and data.
 * Runs automatically before npm uninstall.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

const CONFIG = join(homedir(), ".wmcli.json");
const DATA_DIR = join(homedir(), ".wmcli");

function remove(wmcliOnly: boolean): void {
  if (existsSync(CONFIG)) {
    rmSync(CONFIG);
    console.log("[wmcli] Removed ~/.wmcli.json");
  }
  if (!wmcliOnly && existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log("[wmcli] Removed ~/.wmcli/ (memory database)");
  }
}

// Non-interactive: check WMCLI_UNINSTALL env var
const mode = process.env.WMCLI_UNINSTALL;
if (mode === "full") {
  remove(false);
  console.log("[wmcli] Full uninstall complete (config + data removed).");
} else if (mode === "config") {
  remove(true);
  console.log("[wmcli] Config removed. Memory database kept at ~/.wmcli/");
} else {
  // Default: just remove config, keep data
  remove(true);
  console.log("[wmcli] Config removed. Memory database kept at ~/.wmcli/");
  console.log("[wmcli] To also remove memory data: rm -rf ~/.wmcli/");
  console.log("[wmcli] Note: API keys in ~/.pi/agent/auth.json are shared with pi and were NOT removed.");
}
