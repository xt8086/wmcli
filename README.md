# wmcli

CLI task runner with expert sub-agent delegation. Models from any provider.

A single AI coordinator orchestrates specialist sub-agents for coding, vision, and web research — all from your terminal.

```
wmcli > analyze this error log and find a fix
wmcli > what does this screenshot show?
wmcli > what's the latest on Rust 2.0?
```

## Features

- **972 models across 32 providers** — OpenRouter, OpenAI, Anthropic, Google, DeepSeek, xAI, Groq, Mistral, and more
- **Expert delegation** — main model spawns coding, vision, and research sub-agents automatically
- **Per-provider API keys** — start with one OpenRouter key, add direct provider keys later
- **Hot-swap models** — switch main or vision model at runtime, no restart
- **Thinking/reasoning support** — steerable thinking levels for reasoning models
- **Session persistence** — conversations survive restarts
- **Semantic memory** — search past sessions by meaning, not just keywords
- **Markdown terminal rendering** — tables, bold, code blocks render properly
- **Live web research** — Perplexity Sonar for current data

## Prerequisites

- **Node.js ≥ 20** ([install](https://nodejs.org/))
- **C++ build tools** — required for the SQLite native module:
  ```bash
  # Ubuntu/Debian
  sudo apt install build-essential python3

  # Fedora
  sudo dnf install gcc-c++ make python3

  # macOS
  xcode-select --install

  # Windows — install Visual Studio Build Tools
  # (or run: npm install -g windows-build-tools)
  ```

## Install

```bash
npm install -g wmcli
```

The postinstall script automatically rebuilds the SQLite native module for your platform.

On first run, it prompts for an OpenRouter API key. Get one free at [openrouter.ai/keys](https://openrouter.ai/keys).

You can also set the key via environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
wmcli
```

## Quick Start

```bash
wmcli
```

```
  ┌──────────────────────────────────────────────────┐
  │  API key needed for OpenRouter                   │
  ├──────────────────────────────────────────────────┤
  │  Get a key at: https://openrouter.ai/keys        │
  │  Or set env: OPENROUTER_API_KEY                  │
  └──────────────────────────────────────────────────┘

  Enter OpenRouter API key (or press Enter to skip): sk-or-v1-...
  ✅ API key saved. You can change it anytime with /key.

  Main:   openrouter/z-ai/glm-5.1 (reasoning)
  Vision: openrouter/google/gemini-2.0-flash-001 (image description)
  Tools: web_fetch, recall_sessions
  Experts: delegate_coding, delegate_vision, delegate_research
  Type /help for commands, /quit to exit.

wmcli >
```

One key covers everything — main model, vision, and research all route through OpenRouter.

## Commands

| Command | Action |
|---------|--------|
| `/model [search]` | List/search 972 models across all providers |
| `/model <number>` | Select main model from search results (e.g. `/model 5`) |
| `/model <provider/id>` | Switch directly (e.g. `/model anthropic/claude-sonnet-4`) |
| `/vision [search]` | List/search vision-capable models |
| `/vision <number>` | Select vision model by number (hot-swaps at runtime) |
| `/vision <provider/id>` | Switch vision model directly (e.g. `/vision google/gemini-2.0-flash`) |
| `/key` | Show all configured API keys (masked) |
| `/key <provider>` | Show key for a specific provider |
| `/key set <provider>` | Add an API key for a provider |
| `/key clear <provider>` | Remove a provider's stored key |
| `/thinking` or `/t` | Cycle thinking level (off → minimal → low → medium → high) |
| `/thinking <level>` | Set directly (e.g. `/t high`, `/t off`) |
| `/status` | Show model, vision, thinking, and key status |
| `/memory` or `/m` | Show past indexed sessions |
| `/quit` or `/q` | Exit (saves session to memory) |

## Supported Providers

wmcli works with any provider in pi's ModelRegistry. Common providers with API key support:

| Provider | Env Var | Key URL |
|----------|---------|---------|
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Google AI | `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| DeepSeek | `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| xAI | `XAI_API_KEY` | [console.x.ai](https://console.x.ai/) |
| Groq | `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| Mistral | `MISTRAL_API_KEY` | [console.mistral.ai](https://console.mistral.ai/api-keys) |
| Cerebras | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai/) |
| Fireworks | `FIREWORKS_API_KEY` | [app.fireworks.ai](https://app.fireworks.ai/) |
| Hugging Face | `HF_TOKEN` | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) |

All provider keys can also be set at runtime with `/key set <provider>`.

## Going Direct: OpenRouter → Provider API Keys

Start with OpenRouter. Add direct keys when you want lower latency or direct billing:

```
wmcli > /model anthropic/claude-sonnet-4
  ⚠️  No API key for Anthropic. Use /key set anthropic

wmcli > /key set anthropic
  Set API key for Anthropic
  Get a key at: https://console.anthropic.com/settings/keys
  Enter Anthropic API key: sk-ant-...
  ✅ Anthropic API key saved.

wmcli > /vision google/gemini-2.0-flash
  ✅ Vision model switched to google/gemini-2.0-flash
  ⚠️  No API key for Google AI. Use /key set google
```

Models from providers without a configured key show ⚠️ in `/model` and `/vision` search results.

## CLI Flags

```bash
# Set runtime-only keys (not persisted to disk)
wmcli --api-key openrouter=sk-or-v1-... --api-key anthropic=sk-ant-...

# Backward compat: bare key defaults to openrouter
wmcli --api-key sk-or-v1-...
```

## Session Persistence & Memory

- **Session resume**: restarting wmcli continues your last conversation — no context lost
- **Semantic memory**: on exit, session content is embedded and stored in `~/.wmcli/memory.db`. The main model can recall past sessions via the `recall_sessions` tool using cosine similarity search
- **Embedding cost**: ~$0.02 per 1M tokens (OpenRouter `text-embedding-3-small`, 1536 dimensions)

## Architecture

```
User → [user-selected model] (Main Coordinator)
         │
         ├── delegate_coding   → [same as main] (isolated session)
         ├── delegate_vision   → vision model (image description)
         ├── delegate_research → Perplexity Sonar via OpenRouter (live web search)
         ├── recall_sessions   → SQLite + OpenRouter embeddings
         └── web_fetch          → Direct HTTP fetch
```

| Role | Default Model | Purpose |
|------|--------------|---------|
| Main | openrouter/z-ai/glm-5.1 | Reasoning, tools, coordination |
| Vision | openrouter/google/gemini-2.0-flash-001 | Image description, OCR |
| Coding | Same as main | Code, math, science (isolated session) |
| Research | perplexity/sonar | Live web search + synthesis |
| Embedding | openai/text-embedding-3-small | Session memory (1536 dims) |

The system prompt includes the current date/time, timezone, locale, OS, shell, and working directory so the model has full context.

## Config Files

| File | Purpose |
|------|---------|
| `~/.wmcli.json` | Model choices (`{"model": "openrouter/z-ai/glm-5.1", "visionModel": "openrouter/google/gemini-2.0-flash-001"}`) |
| `~/.pi/agent/auth.json` | API keys per provider (shared with [pi](https://github.com/mariozechner/pi)) |
| `~/.pi/agent/sessions/` | Session history (shared with pi) |
| `~/.wmcli/memory.db` | SQLite embedding store for session recall |

## Uninstall

```bash
npm uninstall -g wmcli

# Config is automatically removed. Memory data is kept by default:
rm ~/.wmcli.json          # (already removed by uninstall)
rm -rf ~/.wmcli/          # remove memory database (optional)

# To remove everything including memory during uninstall:
WMCLI_UNINSTALL=full npm uninstall -g wmcli

# Note: API keys in ~/.pi/agent/auth.json are shared with pi and NOT removed.
```

## Build from Source

```bash
git clone https://github.com/xt8086/wmcli.git
cd wmcli
npm install          # installs deps + rebuilds native modules + patches pi SDK
npm run build        # compile TypeScript
npm link             # makes `wmcli` available globally
```

## License

MIT
