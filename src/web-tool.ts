/**
 * Web fetch tool — fetches and extracts text from web pages.
 */

import { Type } from "typebox";

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export const webFetchTool = {
  name: "web_fetch",
  description: `Fetch the content of a web page and extract readable text.
Use this to look up documentation, research topics, or verify information.
Provide a single URL. Strips HTML, returns plain text (max 50KB).`,
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
  }),
  execute: async (
    _toolCallId: string,
    params: { url: string },
    signal?: AbortSignal
  ) => {
    try {
      const response = await fetch(params.url, {
        signal: signal ?? AbortSignal.timeout(15_000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; wmcli/1.0; +https://github.com)",
        },
      });

      if (!response.ok) {
        return toolResult(`Error: HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();

      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const maxChars = 50_000;
      if (text.length > maxChars) {
        text =
          text.slice(0, maxChars) +
          `\n\n[Truncated at ${maxChars} chars. Full: ${text.length}]`;
      }

      if (!text) return toolResult("No text content extracted from this page.");
      return toolResult(`[Source: ${params.url}]\n\n${text}`);
    } catch (err: any) {
      return toolResult(`Error fetching ${params.url}: ${err.message || String(err)}`);
    }
  },
};
