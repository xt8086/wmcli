#!/usr/bin/env node
/**
 * wmcli — Intelligent CLI with expert sub-agent delegation.
 * Models from any provider. API keys per provider.
 */

// ── Clean up truly corrupted session files (message entries with null/missing content) ──
// Must run before any pi imports, since loading a corrupted session crashes estimateTokens.
// Only deletes files where a `type: "message"` entry has null/undefined content.
// Session header lines (`type: "session"`) are NOT corruption — they have no message field.
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

{
  const safePath = "--" + process.cwd().replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  const dir = join(homedir(), ".pi", "agent", "sessions", safePath);
  if (existsSync(dir)) {
    let deleted = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        let isCorrupted = false;
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message") {
              const c = obj.message?.content;
              if (c === null || c === undefined) {
                isCorrupted = true;
                break;
              }
            }
          } catch {}
        }
        if (isCorrupted) {
          unlinkSync(join(dir, file));
          deleted++;
        }
      } catch {}
    }
    if (deleted > 0) process.stderr.write(`  Cleaned ${deleted} corrupted session(s).\n`);
  }
}

import {
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import * as readline from "node:readline";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import {
  startup, getSavedModelId, saveModelId, getSavedVisionModelId, saveVisionModelId,
  getRegistry, getAuth, setApiKey, setApiKeyFromFlag, maskKey,
  providerOf, PROVIDER_INFO, VISION_MODEL, createVisionSession,
} from "./config.js";
import { createCodingExpertTool, createVisionExpertTool, createResearchExpertTool } from "./experts.js";
import { webFetchTool } from "./web-tool.js";
import { recallSessionsTool } from "./recall-tool.js";
import { storeSession, closeMemory, listSessions } from "./memory.js";


let mainSession: AgentSession | undefined;
let visionSession: AgentSession | undefined;
let codingSession: AgentSession | undefined;
let _visionRef = (): AgentSession | undefined => visionSession;
let _codingRef = (): AgentSession | undefined => codingSession;
let _isThinking = false;
let _textBuffer = "";

/** Format token counts like pi: 999 → "999", 1.2k, 12k, 1.2M, 12M */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Build a pi-style status line from session stats. */
function formatStatusLine(session: AgentSession): string {
  const stats = session.getSessionStats();
  const ctx = session.getContextUsage();
  const model = (session as any).model;
  const thinkingLevel = session.thinkingLevel;

  const parts: string[] = [];
  if (stats.tokens.input > 0) parts.push(`↑${formatTokens(stats.tokens.input)}`);
  if (stats.tokens.output > 0) parts.push(`↓${formatTokens(stats.tokens.output)}`);
  if (stats.tokens.cacheRead > 0) parts.push(`R${formatTokens(stats.tokens.cacheRead)}`);
  if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(3)}`);
  const ctxWindow = ctx?.contextWindow ?? model?.contextWindow ?? 0;
  if (ctx && ctx.percent !== null) {
    parts.push(`${ctx.percent.toFixed(1)}%/${formatTokens(ctxWindow)}`);
  } else if (ctxWindow > 0) {
    parts.push(`?/${formatTokens(ctxWindow)}`);
  }
  const modelLabel = model ? `${model.provider}/${model.id}` : getSavedModelId();
  const thinkLabel = thinkingLevel !== "off" ? ` • ${thinkingLevel}` : "";
  parts.push(`(${modelLabel})${thinkLabel}`);

  return parts.join(" ");
}

// Markdown renderer for terminal output
const _marked = new Marked();
_marked.use(markedTerminal() as any);

async function main(): Promise<void> {
  // Handle --api-key CLI flags (can specify multiple: --api-key openrouter=sk-... --api-key anthropic=sk-...)
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--api-key" && process.argv[i + 1]) {
      const val = process.argv[++i];
      const eqIdx = val.indexOf("=");
      if (eqIdx > 0) {
        const provider = val.slice(0, eqIdx);
        const key = val.slice(eqIdx + 1);
        setApiKeyFromFlag(provider, key);
      } else {
        // Bare key without provider= — default to openrouter for backward compat
        setApiKeyFromFlag("openrouter", val);
      }
    }
  }

  const codingExpert   = createCodingExpertTool(() => _codingRef());
  const visionExpert   = createVisionExpertTool(() => _visionRef());
  const researchExpert = createResearchExpertTool();
  const tools = [webFetchTool, recallSessionsTool, codingExpert, visionExpert, researchExpert];
  const result = await startup(tools);
  if (!result.ok) process.exit(1);
  mainSession = result.mainSession;
  visionSession = result.visionSession;
  codingSession = result.codingSession;
  // Ensure thinking is enabled for reasoning models (session may have saved thinkingLevel: "off")
  if (mainSession && mainSession.supportsThinking() && mainSession.thinkingLevel === "off") {
    mainSession.setThinkingLevel("medium");
  }
  subscribeToEvents(mainSession!);
  console.log(`  Tools: web_fetch, recall_sessions`);
  console.log(`  Experts: delegate_coding, delegate_vision, delegate_research`);
  console.log(`  Type /help for commands, /quit to exit.\n`);
  await runRepl();
}

let _rl: readline.Interface | undefined;
let _rlClosed = false;

async function runRepl(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY || false });
  _rl = rl;
  const showPrompt = () => { if (_rlClosed) return; try { rl.setPrompt("wmcli > "); rl.prompt(); } catch {} };
  let lineQueue = Promise.resolve();
  rl.on("line", (line: string) => {
    lineQueue = lineQueue.then(async () => {
      const input = line.trim();
      if (!input) { showPrompt(); return; }
      if (input.startsWith("/")) { if (await handleCommand(input)) { showPrompt(); return; } }
      await processInput(input);
      showPrompt();
    });
  });
  rl.on("SIGINT", () => { console.log("\nGoodbye!"); _rlClosed = true; rl.close(); saveMemoryAndExit(); });
  showPrompt();
}

async function handleCommand(input: string): Promise<boolean> {
  const [cmd, ...args] = input.split(/\s+/);
  const arg = args.join(" ");
  switch (cmd) {
    case "/quit": case "/q": console.log("Goodbye!"); _rlClosed = true; _rl?.close(); saveMemoryAndExit(); return true;
    case "/thinking": case "/t": {
      if (!mainSession) { console.log(`  No session.`); return true; }
      const levels = mainSession.getAvailableThinkingLevels();
      if (levels.length === 0) { console.log(`  Model does not support thinking.`); return true; }
      if (!arg) {
        const next = mainSession.cycleThinkingLevel();
        console.log(`  Thinking: ${next ?? mainSession.thinkingLevel}`);
      } else {
        const target = arg.toLowerCase();
        if (levels.includes(target as any)) {
          mainSession.setThinkingLevel(target as any);
          console.log(`  Thinking: ${target}`);
        } else {
          console.log(`  Unknown level "${target}". Available: ${levels.join(", ")}`);
        }
      }
      return true;
    }
    case "/model": {
      await handleModelCommand(arg);
      return true;
    }
    case "/vision": {
      await handleVisionCommand(arg);
      return true;
    }
    case "/key": {
      await handleKeyCommand(arg);
      return true;
    }
    case "/status": {
      await handleStatusCommand();
      return true;
    }
    case "/memory": case "/m":
      try {
        const sessions = listSessions();
        if (sessions.length === 0) console.log(`\n  No past sessions.`);
        else { console.log(`\n  ${sessions.length} past session(s):`); sessions.forEach((s: any) => console.log(`  ${(s.createdAt||"").slice(0,16)} | ${s.messageCount}m | ${s.summary.slice(0,100).replace(/\n/g," ")}...`)); }
      } catch (err: any) { console.log(`  Error: ${err.message}`); }
      return true;
    case "/help":
      console.log(`\n  Commands:\n`);
      console.log(`  /model [search]         List/search models (972 across 32 providers)`);
      console.log(`  /model <number>          Select main model by number from last search`);
      console.log(`  /model <provider/id>     Switch directly (e.g. /model anthropic/claude-sonnet-4)`);
      console.log(`  /vision [search]         List/search vision-capable models`);
      console.log(`  /vision <number>         Select vision model (hot-swaps at runtime)`);
      console.log(`  /vision <provider/id>    Switch vision model directly`);
      console.log(`  /key                     Show all configured API keys`);
      console.log(`  /key <provider>          Show key for a provider`);
      console.log(`  /key set <provider>      Add an API key`);
      console.log(`  /key clear <provider>    Remove a provider's key`);
      console.log(`  /thinking (/t)           Cycle thinking level`);
      console.log(`  /thinking <level> (/t)   Set level directly (off/minimal/low/medium/high)`);
      console.log(`  /status                  Show model, vision, thinking, and key status`);
      console.log(`  /memory (/m)             Show past indexed sessions`);
      console.log(`  /quit (/q)               Exit (saves session to memory)`);
      console.log(`\n  CLI flags: --api-key <provider>=<key>`);
      return true;
    default: console.log(`Unknown: ${cmd}`); return true;
  }
}

async function processInput(input: string): Promise<void> {
  if (!mainSession) return;
  try { await mainSession.prompt(input); } catch (err: any) { console.error(`\nError: ${err.message || err}`); }
}

// ---------------------------------------------------------------------------
// /status — show model, vision, thinking, and API key status
// ---------------------------------------------------------------------------

async function handleStatusCommand(): Promise<void> {
  const curModel = mainSession ? (mainSession as any).model : undefined;
  const modelId = getSavedModelId();
  const visionId = getSavedVisionModelId();
  const auth = getAuth();

  console.log(`\n  Main:    ${modelId}${curModel?.reasoning ? " (reasoning)" : ""}`);
  console.log(`  Vision:  ${visionId}${visionSession ? " ✅" : " ❌"}`);
  console.log(`  Thinking: ${mainSession?.thinkingLevel ?? "?"}`);

  // Show API key status for all configured + needed providers
  const neededProviders = new Set([providerOf(modelId), providerOf(visionId)]);
  // Also show any other configured providers
  for (const p of auth.list()) neededProviders.add(p);

  const lines: string[] = [];
  for (const provider of [...neededProviders].sort()) {
    const status = auth.getAuthStatus(provider);
    const label = PROVIDER_INFO[provider]?.label || provider;
    if (status.configured) {
      const cred = auth.get(provider);
      const masked = maskKey(cred) || "✅";
      const source = status.source === "stored" ? "" : ` (${status.source})`;
      lines.push(`    ${label.padEnd(14)} ${masked}${source}`);
    } else {
      const info = PROVIDER_INFO[provider];
      const hint = info?.envVar ? ` (set ${info.envVar})` : "";
      lines.push(`    ${label.padEnd(14)} ❌ not set${hint}`);
    }
  }
  console.log(`  API Keys:`);
  lines.forEach(l => console.log(l));
}

// ---------------------------------------------------------------------------
// /key — manage API keys per provider
// ---------------------------------------------------------------------------

async function handleKeyCommand(arg: string): Promise<void> {
  const auth = getAuth();

  // Parse: /key [action] [provider]
  // Forms: /key              → show all keys
  //        /key openrouter   → show key for specific provider
  //        /key set openrouter → set key for provider
  //        /key clear openrouter → clear key for provider
  const parts = arg.split(/\s+/).filter(Boolean);
  let action = "show";
  let provider = "";

  if (parts.length === 1) {
    // Could be "set", "clear", or a provider name
    if (parts[0] === "set" || parts[0] === "clear") {
      action = parts[0];
    } else {
      provider = parts[0];
    }
  } else if (parts.length >= 2) {
    action = parts[0];
    provider = parts[1];
  }

  // Show all configured keys
  if (action === "show" && !provider) {
    const configured = auth.list();
    if (configured.length === 0) {
      console.log(`\n  No API keys configured. Use /key set <provider> to add one.`);
      return;
    }
    console.log(`\n  Configured API keys:\n`);
    for (const p of configured.sort()) {
      const cred = auth.get(p);
      const label = PROVIDER_INFO[p]?.label || p;
      const masked = maskKey(cred) || "✅";
      console.log(`    ${label.padEnd(14)} ${masked}`);
    }
    console.log(`\n  Use /key set <provider> to add, /key clear <provider> to remove.`);
    return;
  }

  // Show a specific provider
  if (action === "show" && provider) {
    const cred = auth.get(provider);
    const label = PROVIDER_INFO[provider]?.label || provider;
    if (cred && cred.type === "api_key") {
      console.log(`\n  ${label}: ${maskKey(cred)}`);
    } else {
      console.log(`\n  No key configured for ${label}.`);
    }
    console.log(`  Use /key set ${provider} to add a key.`);
    return;
  }

  // Set a key
  if (action === "set") {
    if (!provider) {
      console.log(`  Usage: /key set <provider>`);
      console.log(`  Common providers: ${Object.values(PROVIDER_INFO).slice(0, 6).map(i => i.label).join(", ")}, ...`);
      return;
    }
    const info = PROVIDER_INFO[provider];
    const label = info?.label || provider;
    console.log(`\n  Set API key for ${label}`);
    if (info) console.log(`  Get a key at: ${info.url}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise<string>((resolve) => {
      rl.question(`  Enter ${label} API key: `, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
    if (!key) {
      console.log("  No key entered. Cancelled.");
      return;
    }
    setApiKey(provider, key);
    console.log(`  ✅ ${label} API key saved.`);
    return;
  }

  // Clear a key
  if (action === "clear") {
    if (!provider) {
      console.log(`  Usage: /key clear <provider>`);
      return;
    }
    const label = PROVIDER_INFO[provider]?.label || provider;
    if (!auth.hasAuth(provider)) {
      console.log(`  No key configured for ${label}.`);
      return;
    }
    auth.remove(provider);
    console.log(`  ✅ ${label} API key removed.`);
    return;
  }
}

// ---------------------------------------------------------------------------
// /model — search and select models across all providers
// ---------------------------------------------------------------------------

// Keep last search results for number selection
let _lastModelSearch: { id: string; provider: string; name: string; reasoning: boolean; costOut: number; ctx: number }[] = [];

async function handleModelCommand(arg: string): Promise<void> {
  const registry = getRegistry();
  const auth = getAuth();
  const allModels = registry.getAll();

  // If arg is a number from last search, select that model
  if (arg && /^\d+$/.test(arg)) {
    const idx = parseInt(arg) - 1;
    if (idx < 0 || idx >= _lastModelSearch.length) {
      console.log(`  Invalid number. Use 1-${_lastModelSearch.length}.`);
      return;
    }
    const pick = _lastModelSearch[idx];
    const model = registry.find(pick.provider, pick.id);
    if (!model || !mainSession) { console.log(`  Model not found.`); return; }
    try {
      await mainSession.setModel(model);
      saveModelId(`${pick.provider}/${pick.id}`);
      console.log(`  ✅ Switched to ${pick.provider}/${pick.id}${model.reasoning ? " (reasoning)" : ""}`);
      // Warn if no key for this provider
      if (!auth.hasAuth(pick.provider) && !PROVIDER_INFO[pick.provider]) {
        console.log(`  ⚠️  No API key for ${pick.provider}. Use /key set ${pick.provider}`);
      } else if (!auth.hasAuth(pick.provider)) {
        console.log(`  ⚠️  No API key for ${PROVIDER_INFO[pick.provider]?.label || pick.provider}. Use /key set ${pick.provider}`);
      }
      if (mainSession.supportsThinking() && mainSession.thinkingLevel === "off") {
        mainSession.setThinkingLevel("medium");
        console.log(`  Thinking: medium`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
    return;
  }

  // If arg is a full model id (contains /), switch directly
  if (arg && arg.includes("/")) {
    const provider = providerOf(arg);
    const modelSubId = arg.slice(provider.length + 1);
    const model = registry.find(provider, modelSubId);
    if (!model || !mainSession) { console.log(`  Model not found: ${arg}`); return; }
    try {
      await mainSession.setModel(model);
      saveModelId(arg);
      console.log(`  ✅ Switched to ${arg}${model.reasoning ? " (reasoning)" : ""}`);
      if (!auth.hasAuth(provider)) {
        console.log(`  ⚠️  No API key for ${PROVIDER_INFO[provider]?.label || provider}. Use /key set ${provider}`);
      }
      if (mainSession.supportsThinking() && mainSession.thinkingLevel === "off") {
        mainSession.setThinkingLevel("medium");
        console.log(`  Thinking: medium`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
    return;
  }

  // Search or list models across all providers
  const query = arg.toLowerCase();

  let models = allModels
    .map(m => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
      reasoning: m.reasoning,
      costOut: m.cost?.output ?? 0,
      ctx: m.contextWindow,
    }))
    .filter(m => {
      if (!query) return true;
      // Search across id (with provider prefix), name, and provider
      const fullId = `${m.provider}/${m.id}`.toLowerCase();
      return fullId.includes(query) || m.name.toLowerCase().includes(query);
    });

  // Sort: reasoning models first, then by cost
  models.sort((a, b) => {
    if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
    return a.costOut - b.costOut;
  });

  const maxShow = 30;
  const total = models.length;
  const shown = models.slice(0, maxShow);
  _lastModelSearch = shown;

  if (total === 0) {
    console.log(`  No models matching "${arg}".`);
    return;
  }

  // Count providers in results
  const resultProviders = [...new Set(shown.map(m => m.provider))];

  console.log(`\n  Models${query ? ` matching "${arg}"` : ""} (${total} across ${resultProviders.length} provider(s)):\n`);

  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const num = String(i + 1).padStart(2, " ");
    const tag = m.reasoning ? "🧠" : "  ";
    const cost = m.costOut > 0 ? `$${m.costOut.toFixed(2)}` : "free";
    const ctx = formatTokens(m.ctx);
    const keyIcon = auth.hasAuth(m.provider) ? "" : "⚠️";
    const fullId = `${m.provider}/${m.id}`;
    console.log(`  ${num}. ${tag} ${fullId.padEnd(42)} ${cost.padStart(7)}/M  ctx:${ctx} ${keyIcon}`);
  }
  if (total > maxShow) {
    console.log(`\n  ... and ${total - maxShow} more. Use /model <search> to narrow down.`);
  }
  console.log(`\n  ⚠️ = no API key set. Use /key set <provider> to add one.`);
  console.log(`  Use /model <number> to select, or /model <provider/id> directly.`);
}

// ---------------------------------------------------------------------------
// /vision — search and select vision models (hot-swaps the vision session)
// ---------------------------------------------------------------------------

// Keep last search results for number selection
let _lastVisionSearch: { id: string; provider: string; name: string; reasoning: boolean; costOut: number; ctx: number }[] = [];

async function handleVisionCommand(arg: string): Promise<void> {
  const registry = getRegistry();
  const auth = getAuth();
  const allModels = registry.getAll();

  // If arg is a number from last search, select that model
  if (arg && /^\d+$/.test(arg)) {
    const idx = parseInt(arg) - 1;
    if (idx < 0 || idx >= _lastVisionSearch.length) {
      console.log(`  Invalid number. Use 1-${_lastVisionSearch.length}.`);
      return;
    }
    const pick = _lastVisionSearch[idx];
    const model = registry.find(pick.provider, pick.id);
    if (!model) { console.log(`  Model not found.`); return; }
    const visionId = `${pick.provider}/${pick.id}`;
    saveVisionModelId(visionId);
    // Hot-swap the vision session
    try {
      const sm = (mainSession as any)?.sessionManager;
      if (sm && model) {
        visionSession = await createVisionSession(registry, auth, sm, model);
        console.log(`  ✅ Vision model switched to ${visionId}`);
      } else {
        console.log(`  ✅ Vision model saved as ${visionId} (restart to activate)`);
      }
    } catch (err: any) {
      console.log(`  ✅ Vision model saved as ${visionId} (session swap failed: ${err.message})`);
    }
    if (!auth.hasAuth(pick.provider)) {
      console.log(`  ⚠️  No API key for ${PROVIDER_INFO[pick.provider]?.label || pick.provider}. Use /key set ${pick.provider}`);
    }
    return;
  }

  // If arg is a full model id (contains /), switch directly
  if (arg && arg.includes("/")) {
    const provider = providerOf(arg);
    const modelSubId = arg.slice(provider.length + 1);
    const model = registry.find(provider, modelSubId);
    if (!model) { console.log(`  Vision model not found: ${arg}`); return; }
    saveVisionModelId(arg);
    try {
      const sm = (mainSession as any)?.sessionManager;
      if (sm) {
        visionSession = await createVisionSession(registry, auth, sm, model);
        console.log(`  ✅ Vision model switched to ${arg}`);
      } else {
        console.log(`  ✅ Vision model saved as ${arg} (restart to activate)`);
      }
    } catch (err: any) {
      console.log(`  ✅ Vision model saved as ${arg} (session swap failed: ${err.message})`);
    }
    if (!auth.hasAuth(provider)) {
      console.log(`  ⚠️  No API key for ${PROVIDER_INFO[provider]?.label || provider}. Use /key set ${provider}`);
    }
    return;
  }

  // Search vision-capable models (filter to models that accept image input)
  const query = arg.toLowerCase();
  let models = allModels
    .filter(m => m.input?.includes("image"))
    .map(m => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
      reasoning: m.reasoning,
      costOut: m.cost?.output ?? 0,
      ctx: m.contextWindow,
    }))
    .filter(m => {
      if (!query) return true;
      const fullId = `${m.provider}/${m.id}`.toLowerCase();
      return fullId.includes(query) || m.name.toLowerCase().includes(query);
    });

  // Sort: cheapest first (vision models are typically non-reasoning)
  models.sort((a, b) => a.costOut - b.costOut);

  const maxShow = 30;
  const total = models.length;
  const shown = models.slice(0, maxShow);
  _lastVisionSearch = shown;

  if (total === 0) {
    console.log(`  No vision models matching "${arg}".`);
    return;
  }

  const currentVisionId = getSavedVisionModelId();
  const resultProviders = [...new Set(shown.map(m => m.provider))];

  console.log(`\n  Vision models${query ? ` matching "${arg}"` : ""} (${total} across ${resultProviders.length} provider(s)):`);
  console.log(`  Current: ${currentVisionId}\n`);

  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const num = String(i + 1).padStart(2, " ");
    const tag = m.reasoning ? "🧠" : "  ";
    const cost = m.costOut > 0 ? `$${m.costOut.toFixed(2)}` : "free";
    const ctx = formatTokens(m.ctx);
    const keyIcon = auth.hasAuth(m.provider) ? "" : "⚠️";
    const fullId = `${m.provider}/${m.id}`;
    const current = fullId === currentVisionId ? " ← current" : "";
    console.log(`  ${num}. ${tag} ${fullId.padEnd(42)} ${cost.padStart(7)}/M  ctx:${ctx} ${keyIcon}${current}`);
  }
  if (total > maxShow) {
    console.log(`\n  ... and ${total - maxShow} more. Use /vision <search> to narrow down.`);
  }
  console.log(`\n  ⚠️ = no API key set. Use /key set <provider> to add one.`);
  console.log(`  Use /vision <number> to select, or /vision <provider/id> directly.`);
}

// ---------------------------------------------------------------------------
// Event streaming
// ---------------------------------------------------------------------------

function subscribeToEvents(session: AgentSession): void {
  let lastOutput: "nothing" | "thinking" | "tool" | "text" = "nothing";

  function blankLine(): void {
    process.stdout.write("\n");
  }

  session.subscribe((event: AgentSessionEvent) => {
    try {
      const e = event as any;

      if (e.type === "message_start") {
        _isThinking = false;
        _textBuffer = "";
        return;
      }

      if (e.type === "message_update") {
        const sub = e.assistantMessageEvent?.type;

        if (sub === "thinking_start") {
          _isThinking = true;
          if (lastOutput === "tool" || lastOutput === "thinking") blankLine();
          process.stdout.write("\x1b[2m\x1b[3m  💭 ");
        } else if (sub === "thinking_delta") {
          process.stdout.write(e.assistantMessageEvent.delta);
        } else if (sub === "thinking_end") {
          _isThinking = false;
          process.stdout.write("\x1b[0m");
          lastOutput = "thinking";
        } else if (sub === "text_delta") {
          _textBuffer += e.assistantMessageEvent.delta;
        }
        return;
      }

      if (e.type === "message_end") {
        if (_isThinking) { process.stdout.write("\x1b[0m"); _isThinking = false; }
        if (_textBuffer.trim()) {
          if (lastOutput !== "nothing") blankLine();
          const rendered = _marked.parse(_textBuffer.trim()) as string;
          process.stdout.write(rendered);
          lastOutput = "text";
        }
        _textBuffer = "";
        if (e.message?.role === "assistant" && mainSession) {
          const status = formatStatusLine(mainSession);
          process.stdout.write(`\x1b[2m  ${status}\x1b[0m\n`);
        }
        return;
      }

      if (e.type === "tool_execution_start") {
        blankLine();
        const name = e.toolName;
        const args = e.args;
        let line = "";
        if (name === "bash") {
          line = `  $ ${args?.command ?? ""}`;
        } else if (name === "read") {
          line = `  📖 read ${args?.path ?? ""}`;
        } else if (name === "edit") {
          line = `  ✏️  edit ${args?.path ?? ""}`;
        } else if (name === "write") {
          line = `  📝 write ${args?.path ?? ""}`;
        } else {
          const L: Record<string,string> = {
            delegate_coding:   "  🔧 Coding Expert",
            delegate_vision:   "  👁️  Vision Expert",
            delegate_research: "  🔍 Research Expert",
            recall_sessions:   "  📚 Memory Search",
            web_fetch:         "  🌐 Web Fetch",
          };
          line = L[name] || `  ⚙️  ${name}`;
        }
        console.log(line);
        return;
      }

      if (e.type === "tool_execution_end") {
        const name = e.toolName;
        const result = e.result;
        const isError = e.isError;

        if ("bash read write edit".split(" ").includes(name)) {
          const text = extractResultText(result);
          if (text) {
            const maxLines = 15;
            const lines = text.split("\n");
            const truncated = lines.length > maxLines;
            const shown = lines.slice(0, maxLines).join("\n");
            process.stdout.write("\x1b[2m");
            shown.split("\n").forEach((l: string) => process.stdout.write("    " + l + "\n"));
            if (truncated) process.stdout.write("    ... (" + (lines.length - maxLines) + " more lines)\n");
            process.stdout.write("\x1b[0m");
          }
          if (isError) console.log("  ⚠️  error");
          lastOutput = "tool";
        }

        if (name === "delegate_research") {
          lastOutput = "tool";
        }
        return;
      }

      if (e.type === "error") {
        console.log(`\n⚠️  ${e.error?.message || "Error"}`);
        return;
      }
    } catch {}
  });
}

/** Extract plain text from a tool result (AgentToolResult or raw string). */
function extractResultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("\n");
  }
  return String(result);
}

async function saveMemoryAndExit(): Promise<void> {
  try {
    const extractText = (msg: any): string => {
      const c = msg.content; if (!c) return ""; if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.filter((x:any)=>x?.type==="text").map((x:any)=>x.text||"").join(" ");
      try { return JSON.stringify(c); } catch { return ""; }
    };
    if (mainSession) {
      try {
        const sm = (mainSession as any).sessionManager;
        if (sm) {
          const branch = sm.getBranch();
          if (branch?.length) {
            const content = branch.map((entry: any) => {
              try { if (entry.type==="message"&&entry.message) { const t=extractText(entry.message); if (t.trim()) return `[${entry.message.role||"?"}]: ${t.slice(0,1000)}`; } } catch {}
              return null;
            }).filter(Boolean).join("\n");
            if (content?.length > 50) await storeSession(sm.getSessionPath?.()||"", content);
          }
        }
      } catch {}
    }
  } catch {}
  closeMemory();
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
