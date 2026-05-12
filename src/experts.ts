/**
 * Expert delegation tools — the main model orchestrates work by spawning
 * the right sub-agent for each task type.
 *
 * Coding Expert:   Same as main model — code, debug, refactor, math, science
 * Vision Expert:   Gemini 2.0 Flash (via OpenRouter) — image description, OCR, screenshots
 * Research Expert: Perplexity Sonar (via OpenRouter) — live web search, current data
 */

import { Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAuth, providerOf } from "./config.js";

// Helper: wrap a string result as a proper AgentToolResult
// Custom tools MUST return AgentToolResult, not plain strings.
// Plain strings get serialized with null content in the session JSONL,
// which crashes the agent loop on next startup ("content is not iterable").
function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ---------------------------------------------------------------------------
// Shared: collect response from any session
// ---------------------------------------------------------------------------

async function collectResponse(
  session: AgentSession,
  prompt: string,
  timeoutMs = 300_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; unsub(); resolve(text.trim() || "(timeout)"); }
    }, timeoutMs);

    const unsub = session.subscribe((event: AgentSessionEvent) => {
      const e = event as any;
      if (resolved) return;
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        text += e.assistantMessageEvent.delta;
      }
      if (e.type === "message_end" && e.message?.role === "assistant") {
        resolved = true; clearTimeout(timer); unsub(); resolve(text.trim() || null);
      }
      if (e.type === "error") {
        resolved = true; clearTimeout(timer); unsub(); resolve(null);
      }
    });

    session.prompt(prompt).catch(() => {
      if (!resolved) { resolved = true; clearTimeout(timer); unsub(); resolve(null); }
    });
  });
}

// ---------------------------------------------------------------------------
// Coding expert
// ---------------------------------------------------------------------------

export function createCodingExpertTool(
  getSession: () => AgentSession | undefined
) {
  return {
    name: "delegate_coding",
    description: `Delegate a coding, debugging, math, science, or system design task to a specialist sub-agent.
Use this for:
- Writing, debugging, or refactoring code
- Complex math or scientific problems
- System architecture or technical design
The sub-agent has full file access (read, write, edit, bash).
Do NOT use for web research, image description, or simple queries.`,
    parameters: Type.Object({
      task: Type.String({
        description: "The coding task. Include all context, code, error messages, and requirements.",
      }),
    }),
    execute: async (
      _id: string, params: { task: string }
    ) => {
      const session = getSession();
      if (!session) return toolResult("Error: Coding expert unavailable.");
      const result = await collectResponse(session, params.task);
      return toolResult(result ?? "Coding expert produced no response.");
    },
  };
}

// ---------------------------------------------------------------------------
// Vision expert
// ---------------------------------------------------------------------------

export function createVisionExpertTool(
  getSession: () => AgentSession | undefined
) {
  return {
    name: "delegate_vision",
    description: `Delegate an image description task to a vision-capable sub-agent (Gemini 2.0 Flash via OpenRouter).
Use this when:
- The user shares an image, screenshot, diagram, or photo
- You need to understand visual content (you cannot see images)
Provide the image file path. The vision expert will read it and describe everything.`,
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the image file. E.g., /tmp/screenshot.png or %TEMP%\\screenshot.png",
      }),
      focus: Type.Optional(
        Type.String({
          description: "What to focus on. E.g., 'read all text', 'describe the layout'",
        })
      ),
    }),
    execute: async (
      _id: string, params: { path: string; focus?: string }
    ) => {
      const session = getSession();
      if (!session) return toolResult("Error: Vision expert unavailable.");
      const focus = params.focus ? ` Focus on: ${params.focus}.` : "";
      const prompt = `Read the image at "${params.path}" and describe it in detail.${focus} Include all text, UI elements, error messages, code, diagrams, or any visual content.`;
      const result = await collectResponse(session, prompt, 120_000);
      return toolResult(result ?? "Vision expert produced no description.");
    },
  };
}

// ---------------------------------------------------------------------------
// Research expert (Perplexity Sonar via OpenRouter)
// ---------------------------------------------------------------------------

// Research always goes through OpenRouter (Perplexity Sonar is an OpenRouter model)
let _researchKey: string | null = null;
async function getResearchKey(): Promise<string> {
  if (_researchKey) return _researchKey;
  const auth = getAuth();
  _researchKey = (await auth.getApiKey("openrouter")) || "";
  return _researchKey;
}

export function createResearchExpertTool() {
  return {
    name: "delegate_research",
    description: `Delegate a web research task to Perplexity Sonar, which searches the web live and synthesizes answers.
Use this when you need:
- Current information (prices, versions, news, events)
- Multi-source research and comparison
- Data that may have changed since your training cutoff
Perplexity searches many sources and returns a cited, synthesized answer.
Do NOT use for: reading a specific known URL, coding, or image tasks.`,
    parameters: Type.Object({
      query: Type.String({
        description: "The research question. Be specific for best results.",
      }),
    }),
    execute: async (
      _id: string, params: { query: string }
    ) => {
      try {
        const key = await getResearchKey();
        if (!key) return toolResult("Error: API key not available.");

        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: "perplexity/sonar",
              messages: [{ role: "user", content: params.query }],
              max_tokens: 2000,
            }),
            signal: AbortSignal.timeout(60_000),
          }
        );

        if (!response.ok) {
          const err = await response.text();
          return toolResult(`Error: HTTP ${response.status}: ${err.slice(0, 200)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return toolResult("Perplexity returned no content.");

        const citations = data.citations;
        if (citations?.length) {
          return toolResult(content + "\n\nSources:\n" + citations.slice(0, 5).map((u: string, i: number) => `  [${i + 1}] ${u}`).join("\n"));
        }
        return toolResult(content);
      } catch (err: any) {
        return toolResult(`Error: ${err.message || String(err)}`);
      }
    },
  };
}
