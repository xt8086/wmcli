/**
 * Configuration: models, providers, session setup.
 *
 * Models from any provider. API keys per provider.
 * On first run, prompts for keys needed by chosen models.
 * Model can be changed at runtime via /model command.
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL   = "openrouter/z-ai/glm-5.1";
export const VISION_MODEL    = "openrouter/google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Config file (stores user's model choices + vision model)
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".taskcli.json");

interface TaskCliConfig {
  model: string;
  visionModel?: string;
}

function loadConfig(): TaskCliConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      // Migrate old format: model id without provider prefix → openrouter/model
      // Old config stored e.g. "z-ai/glm-5.1" — the first segment isn't a provider name
      // New format: "openrouter/z-ai/glm-5.1" — first segment IS a provider name
      if (cfg.model) {
        const provider = cfg.model.split("/")[0];
        const registry = getRegistry();
        // If the provider part doesn't match any known provider, it's an old-format id
        if (!registry.getAll().some(m => m.provider === provider)) {
          cfg.model = `openrouter/${cfg.model}`;
          saveConfig(cfg);
        }
      }
      return cfg;
    }
  } catch {}
  return { model: DEFAULT_MODEL };
}

export function saveConfig(config: TaskCliConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  } catch {}
}

export function getSavedModelId(): string {
  return loadConfig().model;
}

export function saveModelId(modelId: string): void {
  const config = loadConfig();
  config.model = modelId;
  saveConfig(config);
}

export function getSavedVisionModelId(): string {
  return loadConfig().visionModel || VISION_MODEL;
}

export function saveVisionModelId(modelId: string): void {
  const config = loadConfig();
  config.visionModel = modelId;
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let _auth: AuthStorage | null = null;
let _registry: ModelRegistry | null = null;

export function getAuth(): AuthStorage {
  if (!_auth) _auth = AuthStorage.create();
  return _auth;
}

export function getRegistry(): ModelRegistry {
  if (!_registry) {
    _registry = ModelRegistry.create(getAuth());
  }
  return _registry;
}

// ---------------------------------------------------------------------------
// Provider info — env var names and key URLs for common providers
// ---------------------------------------------------------------------------

export const PROVIDER_INFO: Record<string, { envVar: string; url: string; label: string }> = {
  openrouter:  { envVar: "OPENROUTER_API_KEY",  url: "https://openrouter.ai/keys",             label: "OpenRouter" },
  openai:      { envVar: "OPENAI_API_KEY",      url: "https://platform.openai.com/api-keys",   label: "OpenAI" },
  anthropic:   { envVar: "ANTHROPIC_API_KEY",   url: "https://console.anthropic.com/settings/keys", label: "Anthropic" },
  google:      { envVar: "GEMINI_API_KEY",      url: "https://aistudio.google.com/apikey",     label: "Google AI" },
  deepseek:    { envVar: "DEEPSEEK_API_KEY",    url: "https://platform.deepseek.com/api_keys", label: "DeepSeek" },
  xai:         { envVar: "XAI_API_KEY",         url: "https://console.x.ai/",                  label: "xAI" },
  groq:        { envVar: "GROQ_API_KEY",        url: "https://console.groq.com/keys",          label: "Groq" },
  mistral:     { envVar: "MISTRAL_API_KEY",     url: "https://console.mistral.ai/api-keys",    label: "Mistral" },
  cerebras:    { envVar: "CEREBRAS_API_KEY",    url: "https://cloud.cerebras.ai/",              label: "Cerebras" },
  fireworks:   { envVar: "FIREWORKS_API_KEY",   url: "https://app.fireworks.ai/",              label: "Fireworks" },
  huggingface: { envVar: "HF_TOKEN",            url: "https://huggingface.co/settings/tokens", label: "Hugging Face" },
  moonshotai:  { envVar: "MOONSHOT_API_KEY",    url: "https://platform.moonshot.cn/",          label: "Moonshot" },
  minimax:     { envVar: "MINIMAX_API_KEY",     url: "https://www.minimaxi.com/",              label: "MiniMax" },
  zai:         { envVar: "ZAI_API_KEY",         url: "https://api.zai.chat/",                   label: "ZAI" },
};

/** Resolve the provider name from a full model id (e.g. "openrouter/z-ai/glm-5.1" → "openrouter"). */
export function providerOf(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx >= 0 ? modelId.slice(0, idx) : modelId;
}

// ---------------------------------------------------------------------------
// API key setup — ensure keys exist for the providers used by chosen models
// ---------------------------------------------------------------------------

async function promptForProviderKey(provider: string): Promise<boolean> {
  const auth = getAuth();
  const info = PROVIDER_INFO[provider];
  const label = info?.label || provider;

  console.log(`\n  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  API key needed for ${label.padEnd(29)}│`);
  console.log(`  ├──────────────────────────────────────────────────┤`);
  if (info) {
    console.log(`  │  Get a key at: ${info.url.padEnd(34)}│`);
    console.log(`  │  Or set env: ${info.envVar.padEnd(36)}│`);
  } else {
    console.log(`  │  Set the API key for provider: ${provider.padEnd(18)}│`);
  }
  console.log(`  └──────────────────────────────────────────────────┘\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise<string>((resolve) => {
    rl.question(`  Enter ${label} API key (or press Enter to skip): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!key) {
    console.log(`  ⚠️  Skipped — ${label} models won't work without a key.`);
    return false;
  }

  auth.set(provider, { type: "api_key", key });
  console.log(`  ✅ ${label} API key saved.\n`);
  return true;
}

/**
 * Ensure API keys are configured for all providers used by chosen models.
 * Checks auth.json, then env vars. Prompts for any missing keys.
 * Returns true if all required keys are present (or user skipped).
 */
async function ensureApiKeys(mainModelId: string, visionModelId: string): Promise<boolean> {
  const auth = getAuth();
  const registry = getRegistry();

  // Collect unique providers needed
  const needed = new Set<string>();
  const mainProvider = providerOf(mainModelId);
  needed.add(mainProvider);
  const visionProvider = providerOf(visionModelId);
  if (visionProvider !== mainProvider) needed.add(visionProvider);

  // Check each provider; prompt for missing ones
  let anyCritical = false;
  for (const provider of needed) {
    if (auth.hasAuth(provider)) continue;

    // Check env var fallback
    const info = PROVIDER_INFO[provider];
    if (info?.envVar && process.env[info.envVar]) {
      auth.set(provider, { type: "api_key", key: process.env[info.envVar]! });
      console.log(`  ✅ Using ${info.envVar} from environment.\n`);
      continue;
    }

    // Also check via pi's getApiKey which handles more env var patterns
    const resolved = await auth.getApiKey(provider).catch(() => undefined);
    if (resolved) continue;

    // Prompt user
    const ok = await promptForProviderKey(provider);
    if (!ok && provider === mainProvider) {
      anyCritical = true; // Main model can't work without a key
    }
  }

  if (anyCritical) {
    console.error(`\n  ❌ No API key for main model provider "${mainProvider}". Cannot continue.`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// API key helpers (used by /key command)
// ---------------------------------------------------------------------------

export function setApiKey(provider: string, key: string): void {
  const auth = getAuth();
  auth.set(provider, { type: "api_key", key });
}

export function setApiKeyFromFlag(provider: string, key: string): void {
  const auth = getAuth();
  auth.setRuntimeApiKey(provider, key);
  console.log(`  ✅ ${PROVIDER_INFO[provider]?.label || provider} API key set via --api-key (runtime only).`);
}

export function maskKey(cred: any): string | undefined {
  if (!cred || cred.type !== "api_key") return undefined;
  const k = cred.key as string;
  if (k.length <= 12) return k.slice(0, 4) + "...";
  return k.slice(0, 7) + "..." + k.slice(-4);
}

// ---------------------------------------------------------------------------
// System context — appended to the system prompt so the model knows about
// the user's environment (timezone, OS, current time, shell, etc.)
// ---------------------------------------------------------------------------

function buildSystemContext(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";
  const now = new Date();
  const dateStr = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
  const os = process.platform;
  const shell = process.env.SHELL || process.env.ComSpec || "unknown";
  const cwd = process.cwd();
  const lang = process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  return [
    `Current date and time: ${dateStr}`,
    `Timezone: ${tz}`,
    `Locale: ${lang}`,
    `OS: ${os}`,
    `Shell: ${shell}`,
    `Working directory: ${cwd}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export interface StartupResult {
  ok: boolean;
  mainModel: Model<any> | undefined;
  visionModel: Model<any> | undefined;
  codingModel: Model<any> | undefined;
  mainSession: AgentSession | undefined;
  visionSession: AgentSession | undefined;
  codingSession: AgentSession | undefined;
  sessionManager: SessionManager | undefined;
}

export async function startup(
  mainTools?: any[]
): Promise<StartupResult> {
  const auth = getAuth();
  const registry = getRegistry();

  const modelId      = getSavedModelId();
  const visionId     = getSavedVisionModelId();
  const mainProvider = providerOf(modelId);
  const visionProvider = providerOf(visionId);

  const mainModel   = registry.find(mainProvider, modelId.slice(mainProvider.length + 1));
  const visionModel = registry.find(visionProvider, visionId.slice(visionProvider.length + 1));
  const codingModel = mainModel; // Same as main, isolated session

  if (!mainModel) {
    console.error(`Model not found: ${modelId}. Run /model to select one.`);
    return { ok: false, mainModel: undefined, visionModel, codingModel, mainSession: undefined, visionSession: undefined, codingSession: undefined, sessionManager: undefined };
  }

  // Ensure API keys for all used providers
  if (!(await ensureApiKeys(modelId, visionId))) {
    return { ok: false, mainModel: undefined, visionModel: undefined, codingModel: undefined, mainSession: undefined, visionSession: undefined, codingSession: undefined, sessionManager: undefined };
  }

  console.log(`\n  Main:   ${modelId}${mainModel.reasoning ? " (reasoning)" : ""}`);
  if (visionModel) console.log(`  Vision: ${visionId} (image description)`);
  else console.log(`  Vision: ${visionId} — NOT FOUND`);

  const sessionManager = SessionManager.continueRecent(process.cwd());

  // System context appended to the built-in system prompt
  const systemContext = buildSystemContext();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(homedir(), ".pi", "agent"),
    appendSystemPrompt: [systemContext],
  });

  // Main session
  const { session: mainSession } = await createAgentSession({
    sessionManager,
    authStorage: auth,
    modelRegistry: registry,
    model: mainModel,
    customTools: mainTools,
    resourceLoader,
  });

  // Vision session (minimal tools — just read for images)
  let visionSession: AgentSession | undefined;
  if (visionModel) {
    visionSession = await createVisionSession(registry, auth, sessionManager, visionModel);
  }

  // Coding session (full tools, no delegation — avoids infinite loops)
  let codingSession: AgentSession | undefined;
  if (codingModel) {
    const { session } = await createAgentSession({
      sessionManager,
      authStorage: auth,
      modelRegistry: registry,
      model: codingModel,
    });
    codingSession = session;
  }

  return {
    ok: true,
    mainModel, visionModel, codingModel,
    mainSession, visionSession, codingSession,
    sessionManager,
  };
}

/** Create a vision session on-the-fly (used by /vision to hot-swap the vision model). */
export async function createVisionSession(
  registry: ModelRegistry,
  auth: AuthStorage,
  sessionManager: SessionManager,
  model: Model<any>,
): Promise<AgentSession> {
  const { session } = await createAgentSession({
    sessionManager,
    authStorage: auth,
    modelRegistry: registry,
    model,
    noTools: "builtin",
    tools: ["read"],
  });
  return session;
}
