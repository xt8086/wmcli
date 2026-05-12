/**
 * Session memory with semantic search via OpenRouter embeddings.
 *
 * Stores session embeddings in a local SQLite database.
 * On each query, the model can call recall_sessions to find
 * relevant past conversations.
 *
 * Flow:
 *   1. Session ends → embed its content → store in DB
 *   2. Later query → embed query → cosine search → return top-K matches
 *   3. Model uses past context to answer
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAuth } from "./config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBED_MODEL = "openai/text-embedding-3-small";
const EMBED_DIMS = 1536;
const DB_PATH = path.join(
  process.env.HOME || "/tmp",
  ".wmcli",
  "memory.db"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionMemory {
  id: string;
  sessionPath: string;
  createdAt: string;
  messageCount: number;
  summary: string; // First 2000 chars of session content
  embedding: Float32Array;
}

interface SearchResult {
  id: string;
  sessionPath: string;
  createdAt: string;
  summary: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// Embedding API
// ---------------------------------------------------------------------------

let apiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (apiKey) return apiKey!;
  // Use pi's AuthStorage — checks auth.json, env vars, runtime overrides
  const auth = getAuth();
  const key = await auth.getApiKey("openrouter");
  if (key) {
    apiKey = key;
    return apiKey!;
  }
  throw new Error(
    "OpenRouter API key not found. Set OPENROUTER_API_KEY env var or use /key set openrouter."
  );
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const key = await getApiKey();
  // Filter out null/empty entries
  const clean = texts.filter((t) => t && t.trim().length > 0);
  if (clean.length === 0) {
    throw new Error("No valid text to embed");
  }
  console.error("[memory] embedding", clean.length, "texts, first:", clean[0]?.slice(0, 60));
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.map(
    (item: any) => new Float32Array(item.embedding)
  );
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      session_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Store a session
// ---------------------------------------------------------------------------

export async function storeSession(
  sessionPath: string,
  content: string
): Promise<void> {
  const database = getDb();

  // Generate stable ID from path
  const id = createHash("sha256").update(sessionPath).digest("hex").slice(0, 16);

  // Check if already stored
  const existing = database
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(id);
  if (existing) return; // Already indexed

  // Count messages
  const lines = content.split("\n").filter((l) => l.trim());
  const messageCount = lines.length;

  // Create summary (first 2000 chars, trimmed to nearest word)
  const summary = content.slice(0, 2000).replace(/\s+\S*$/, "");

  // Embed
  const [embedding] = await embed([summary]);

  // Store
  const buffer = Buffer.from(embedding.buffer);
  database
    .prepare(
      `INSERT INTO sessions (id, session_path, created_at, message_count, summary, embedding)
       VALUES (?, ?, datetime('now'), ?, ?, ?)`
    )
    .run(id, sessionPath, messageCount, summary, buffer);
}

// ---------------------------------------------------------------------------
// Search sessions
// ---------------------------------------------------------------------------

export async function searchSessions(
  query: string,
  topK: number = 3
): Promise<SearchResult[]> {
  const database = getDb();

  // Embed the query
  const [queryEmbedding] = await embed([query]);

  // Load all stored sessions
  const rows = database
    .prepare(
      "SELECT id, session_path, created_at, summary, embedding FROM sessions ORDER BY created_at DESC LIMIT 100"
    )
    .all() as any[];

  if (rows.length === 0) return [];

  // Compute cosine similarity
  const results: SearchResult[] = rows.map((row) => {
    const stored = new Float32Array(row.embedding.buffer);
    const similarity = cosineSimilarity(queryEmbedding, stored);
    return {
      id: row.id,
      sessionPath: row.session_path,
      createdAt: row.created_at,
      summary: row.summary,
      similarity,
    };
  });

  // Sort by similarity descending, take top K
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK).filter((r) => r.similarity > 0.3);
}

// ---------------------------------------------------------------------------
// List all indexed sessions
// ---------------------------------------------------------------------------

export function listSessions(): { id: string; createdAt: string; messageCount: number; summary: string }[] {
  const database = getDb();
  return database
    .prepare(
      "SELECT id, created_at, message_count, summary FROM sessions ORDER BY created_at DESC LIMIT 50"
    )
    .all() as any[];
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function closeMemory(): void {
  if (db) {
    db.close();
    db = null;
  }
}
