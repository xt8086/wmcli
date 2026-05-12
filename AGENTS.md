# wmcli — Agent Context File

> Full project context for AI coding agents. Documents architecture, code, state, decisions, and known issues.

---

## Project Overview

**wmcli** — CLI task runner with expert sub-agent delegation. Models from any provider via pi's ModelRegistry.
GLM 5.1 coordinates experts for coding, vision, and web research.
Sessions persist across restarts. Past conversations searchable via semantic memory.

**Location**: `/home/linovo/wmcli`
**Created**: 2026-05-06
**Revised**: 2026-05-12 v9 — multi-provider models, per-provider API keys, /key command, /vision command, --api-key flag
**Status**: Working — multi-provider model switching, per-provider keys, vision hot-swap, thinking streaming, status line, markdown output, research delegation, memory recall

---

## Architecture

```
User → [user-selected model from any provider] (Main Coordinator)
         │
         ├── delegate_coding   → [same as main] (isolated session)
         ├── delegate_vision   → user-selected vision model (image description)
         ├── delegate_research → Perplexity Sonar via OpenRouter (live web search)
         ├── recall_sessions   → SQLite + OpenRouter embeddings
         └── web_fetch          → Direct HTTP fetch
```

| Role | Model | Default | Capabilities |
|------|-------|---------|-------------|
| Main | User-selected via `/model` | openrouter/z-ai/glm-5.1 | Reasoning, tools, coordination |
| Vision | openrouter/google/gemini-2.0-flash-001 | openrouter/google/gemini-2.0-flash-001 | Image description, OCR |
| Coding | Same as main | — | Code, math, science (isolated) |
| Research | perplexity/sonar via OpenRouter | — | Live web search + synthesis |
| Embed | openai/text-embedding-3-small | — | 1536-dim embeddings |

## Source Code

```
src/
├── index.ts          (~450 lines)  Main entry: REPL, commands, events, model selector, key management, session cleanup + save
├── config.ts         (~220 lines)  Session setup, per-provider API key management, model config persistence
├── experts.ts        (~200 lines)  Three expert tools: coding, vision, research
├── memory.ts         (269 lines)   SQLite + OpenRouter embeddings for semantic recall
├── recall-tool.ts    (~55 lines)   recall_sessions tool — cosine search across past sessions
├── web-tool.ts       (~65 lines)   web_fetch — HTML strip, 50KB truncation
├── marked-terminal.d.ts (3 lines)  Type declarations for marked-terminal
└── scripts/patch-pi.js           Postinstall: fix pi SDK null-guard crash
```
**Total**: ~1260 lines TypeScript

## Dependencies

- `@mariozechner/pi-coding-agent` v0.73.0 — pi SDK for AgentSession, tools, streaming
- `better-sqlite3` — session embedding storage
- `marked` + `marked-terminal` — markdown → ANSI terminal rendering (tables, bold, code blocks)
- `typebox` — runtime type validation for custom tools

## Key Design Decisions

1. **Multi-provider model selection** — `/model` command searches 972 models across 32 providers (OpenRouter, OpenAI, Anthropic, Google, DeepSeek, xAI, Groq, Mistral, etc.). Searchable by name/id. Selectable by number or full `provider/model` ID. Choice persists in `~/.wmcli.json`. Default: `openrouter/z-ai/glm-5.1`.
2. **Coding sub-agent uses same model** — whatever the main model is, the coding expert uses it in an isolated session. No conversation pollution from main session.
3. **Per-provider API key management** — each provider needs its own API key. On startup, wmcli checks that keys exist for the main model's provider and the vision model's provider. Missing keys trigger a prompt with the provider's key URL and env var name. Keys stored in pi's `~/.pi/agent/auth.json` (shared with pi). `/key` command manages keys at runtime. `--api-key provider=key` CLI flag for runtime-only overrides. Env vars checked as fallback.
4. **Expert delegation pattern** — three separate tools for coding, vision, research. Main model decides which to spawn.
5. **Session persistence** — `SessionManager.continueRecent()` resumes last session. Conversations survive restarts.
6. **Cross-session RAG memory** — on exit, session content embedded via OpenRouter → stored in `~/.wmcli/memory.db`. `recall_sessions` tool does cosine similarity search.
7. **All cloud** — no local models. Ollama removed (CPU too slow for inference).
8. **Top-level session cleanup** — truly corrupted sessions (message entries with null content field) deleted at import time, before pi SDK loads them. Only checks `type: "message"` entries — session headers and other entry types are NOT corruption.
9. **Markdown terminal rendering** — assistant text buffered during streaming, rendered via `marked-terminal` on `message_end`. Tables, bold, code blocks render properly in terminal. Thinking streams in real-time (dim italic with 💭 prefix).
10. **Hidden raw research output** — `delegate_research` tool results are consumed internally by the main model, which re-formats them as clean markdown. The raw Perplexity output is not displayed to avoid duplication.
11. **Custom tools return AgentToolResult** — all custom tools (`delegate_coding`, `delegate_vision`, `delegate_research`, `recall_sessions`, `web_fetch`) return proper `{ content: [...], details: {} }` objects. Plain string returns caused `content: null` in session JSONL files, crashing the agent loop on next startup.
12. **Thinking level auto-enable** — reasoning models (like GLM 5.1) have thinking off by default due to pi's session restoring saved `thinkingLevel: "off"` from old sessions. wmcli forces `"medium"` at startup if the model supports thinking but it's off. Users can change it with `/thinking`.
13. **Status line after each response** — pi-style footer showing token stats, cost, context usage, model, and thinking level (e.g. `↑302k ↓15k R4.6M $2.760 36.2%/203k (openrouter/z-ai/glm-5.1) • medium`).
14. **Key warnings in model list** — models from providers without a configured API key show ⚠️ in the `/model` and `/vision` search results. Selecting such a model warns the user to set the key with `/key set <provider>`.
15. **Vision model hot-swap** — `/vision` command lets users search and switch vision models at runtime. The vision session is recreated on-the-fly (no restart needed). Persists in `~/.wmcli.json`.

## Fixed: Session Corruption Root Cause

**Root cause**: custom tools returned plain strings from `execute()` instead of `AgentToolResult` objects.
The pi SDK serializes tool results to session JSONL. When a tool returns a plain string, the SDK
writes the `toolResult` message with `content: null`. On next startup, the agent loop does
`message.content.filter(...)` on this null-content entry, throwing `"content is not iterable"`.
This error response gets saved with `content: []`, and every subsequent prompt also fails — a
cascading failure that makes the session permanently broken.

**Fix**: all custom tools now return `{ content: [{ type: "text", text }], details: {} }` via a
shared `toolResult()` helper. The startup cleanup deletes any sessions with null-content messages
(as a safety net for pre-fix sessions).

**Previous false-positive bug**: the cleanup block also had a bug where it matched session header
lines (`type: "session"`) as corrupted because they have no `message.content` field. Fixed by only
checking `type: "message"` entries.

## Output Streaming

All output goes to stdout. Event handling with visual section separators:
- `thinking_start` → dim italic with 💭 prefix (`\x1b[2m\x1b[3m  💭 `), streams in real-time
- `thinking_delta` → raw text streamed to stdout
- `thinking_end` → reset ANSI codes (`\x1b[0m`)
- `text_delta` → buffered, rendered as markdown via `marked-terminal` on `message_end`
- `message_end` → render buffered text as markdown, then print dim status line
- `tool_execution_start` → formatted label with args (`$ command`, `📖 read path`, `✏️ edit path`, `📝 write path`)
- `tool_execution_end` → dim indented output for bash/read/write/edit (15-line truncation); research results hidden (model re-formats them)
- Blank line separators between: thinking→tool, tool→thinking, tool→text, thinking→text
- `lastOutput` state tracking ensures consistent spacing across multi-turn tool chains

## Session Memory System

- DB: `~/.wmcli/memory.db` (SQLite, WAL mode)
- Embed model: `openai/text-embedding-3-small` (1536 dims, $0.02/1M tokens)
- On exit: extract text from all messages → embed → store with timestamp
- Recall: embed query → cosine similarity → return top-3 above 0.30 similarity

## Commands

| Command | Action |
|---------|--------|
| `/model [search]` | List/search 972 models across all providers; select by number or ID |
| `/model <number>` | Select model from last search results |
| `/model <provider/id>` | Switch directly to a specific model (e.g. `anthropic/claude-sonnet-4`) |
| `/vision [search]` | List/search vision-capable models; select by number or ID |
| `/vision <number>` | Select vision model from last search (hot-swaps session) |
| `/vision <provider/id>` | Switch vision model directly (hot-swaps session) |
| `/key` | Show all configured API keys (masked) |
| `/key <provider>` | Show key status for a specific provider |
| `/key set <provider>` | Prompt to enter a new API key for that provider |
| `/key clear <provider>` | Remove stored API key for that provider |
| `/thinking` or `/t` | Cycle thinking level (off → minimal → low → medium → high) |
| `/thinking <level>` or `/t <level>` | Set thinking level directly |
| `/status` | Show current model, vision, thinking level, and API key status |
| `/memory` or `/m` | Show past indexed sessions |
| `/help` | Help text |
| `/quit` or `/q` | Exit (saves session to memory) |

## CLI Flags

| Flag | Description |
|------|-------------|
| `--api-key <provider>=<key>` | Set runtime-only API key for a provider (not persisted) |
| `--api-key <key>` | Set runtime-only OpenRouter key (backward compat) |

## Model Selection

- 972 models across 32 providers from pi-ai's built-in `ModelRegistry` (static catalog updated with pi-ai releases)
- `/model` lists models (reasoning 🧠 first, sorted by output cost)
- `/model claude` — search by name/id fragment across all providers
- `/model 5` — select by number from last search
- `/model anthropic/claude-sonnet-4` — switch directly
- Models from providers without a configured key show ⚠️
- Choice persisted in `~/.wmcli.json` as `provider/model-id`
- Switching to a reasoning model auto-enables thinking at "medium" if currently off

## Vision Model Selection

- `/vision` lists models that accept image input (584 vision-capable models)
- `/vision gemini` — search vision models by name/id
- `/vision 6` — select by number from last search
- `/vision google/gemini-2.0-flash` — switch directly
- Shows `← current` marker next to the active vision model
- Hot-swaps the vision session at runtime (no restart needed)
- Choice persisted in `~/.wmcli.json` as `visionModel`
- Default: `openrouter/google/gemini-2.0-flash-001` (same provider as default main model)

## Workflow: OpenRouter → Direct API Keys

1. New user starts with OpenRouter — one key covers main + vision + research
2. `/model anthropic/claude-sonnet-4` → warns "⚠️ No API key for Anthropic"
3. `/key set anthropic` → enter key → main model now talks directly to Anthropic
4. `/vision google/gemini-2.0-flash` → warns "⚠️ No API key for Google AI"
5. `/key set google` → enter key → vision model now talks directly to Google
6. Result: main goes direct to Anthropic, vision goes direct to Google, research stays on OpenRouter

## API Key Management

- Keys stored in `~/.pi/agent/auth.json` (shared with pi)
- On startup: checks keys for main model provider + vision model provider
- If missing: prompts with provider name, key URL, and env var hint
- Env var fallback: each provider has a standard env var (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`)
- `/key` command: view, set, clear keys per provider at runtime
- `PROVIDER_INFO` map in `config.ts` defines 14 common providers with env var names and key URLs
- `providerOf()` extracts provider from full model id (e.g. `openrouter/z-ai/glm-5.1` → `openrouter`)

## Config Files

| File | Purpose |
|------|---------|
| `~/.wmcli.json` | User's model choices (`{"model": "openrouter/z-ai/glm-5.1", "visionModel": "openrouter/google/gemini-2.0-flash-001"}`) |
| `~/.pi/agent/auth.json` | API keys per provider (shared with pi) |
| `~/.pi/agent/sessions/` | Session history (shared with pi) |
| `~/.wmcli/memory.db` | SQLite embedding store for session recall |

## Known Issues

1. Research results print as block (no streaming) — tool returns full string at once. Model doesn't re-emit after tool returns.
2. Text response has slight delay before appearing — buffering for markdown rendering means nothing shows until `message_end`. Thinking streams immediately though.
3. `setModel()` switches the main session model but the coding sub-agent keeps its original model until wmcli is restarted.

## Testing

```bash
# Smoke test
printf '/status\n/quit\n' | timeout 10 node dist/index.js

# Key management test
printf '/key\n/key set openrouter\n/quit\n' | timeout 15 node dist/index.js

# Model search test
printf '/model claude\n/quit\n' | timeout 15 node dist/index.js

# Memory test
echo "Search memory: nginx fix" | timeout 30 node dist/index.js

# Vision test (requires image file)
echo "describe /tmp/screenshot.png" | timeout 30 node dist/index.js

# Research test
echo "weather 92880" | timeout 30 node dist/index.js

# Multi-turn test
printf 'how many files in ~/Downloads?\nnow check ~/Documents\n/quit\n' | timeout 60 node dist/index.js

# CLI flag test
node dist/index.js --api-key openrouter=sk-or-v1-xxx --api-key anthropic=sk-ant-xxx
```
