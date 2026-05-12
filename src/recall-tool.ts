/**
 * recall_sessions tool — lets the main model search past conversations.
 */

import { Type } from "typebox";
import { searchSessions } from "./memory.js";

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export const recallSessionsTool = {
  name: "recall_sessions",
  description: `Search your memory of past conversations for relevant information.
Use this when:
- The user references something from a previous session ("what was that command we used?")
- The user asks about past decisions or discussions
- You need context from earlier work that isn't in the current conversation

Returns up to 3 most relevant past conversations with summaries.`,
  parameters: Type.Object({
    query: Type.String({
      description:
        "What to search for. Be specific — mention technologies, file names, error messages, topics.",
    }),
  }),
  execute: async (
    _toolCallId: string,
    params: { query: string },
    _signal?: AbortSignal
  ) => {
    try {
      const query = params.query;
      if (!query || typeof query !== "string" || !query.trim()) {
        return toolResult("Error: search query is required.");
      }

      const results = await searchSessions(query, 3);
      if (results.length === 0) {
        return toolResult("No relevant past conversations found. This might be the first session about this topic.");
      }

      let output = `Found ${results.length} relevant past conversation(s):\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        output += `--- Session ${i + 1} (${r.createdAt}, similarity: ${(r.similarity * 100).toFixed(0)}%) ---\n`;
        output += r.summary + "\n\n";
      }
      return toolResult(output);
    } catch (err: any) {
      return toolResult(`Error: ${err.message || String(err)}`);
    }
  },
};
