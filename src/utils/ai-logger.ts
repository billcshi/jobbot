/**
 * Centralized AI interaction logger.
 *
 * Every LLM call is recorded to local/logs/ai-<date>.jsonl for debugging,
 * cost tracking, and audit purposes.
 *
 * Log files live in local/logs/ (gitignored — never committed).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { AI_REQUEST_TIMEOUT_MS } from './http-json.js';
import { LOCAL_DIR } from './paths.js';

const LOGS_DIR = `${LOCAL_DIR}/logs`;

function logDir(): string {
  mkdirSync(LOGS_DIR, { recursive: true });
  return LOGS_DIR;
}

function todayFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${logDir()}/ai-${yyyy}-${mm}-${dd}.jsonl`;
}

export interface AiLogEntry {
  timestamp: string;
  operation: string;
  model: string;
  provider: string;
  endpoint: string;
  requestSummary: string;
  responseSummary: string;
  promptTokens?: number;      // input tokens
  completionTokens?: number;  // output tokens
  totalTokens?: number;
  cachedTokens?: number;      // prompt_cache_hit_tokens (DeepSeek cache)
  durationMs: number;
  timeoutMs?: number;
  success: boolean;
  error?: string;
}

/**
 * Write one AI interaction to the daily log file.
 */
export function logAiCall(entry: Omit<AiLogEntry, 'timestamp'>): void {
  const record: AiLogEntry = {
    ...entry,
    timeoutMs: entry.timeoutMs ?? AI_REQUEST_TIMEOUT_MS,
    timestamp: new Date().toISOString(),
  };
  const path = todayFile();
  try {
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    // Logging should never crash the app
    console.error('[ai-logger] Failed to write log entry to', path, ':', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Extract token usage from common API response formats.
 * Handles: DeepSeek, Anthropic, OpenAI-compatible.
 */
export function extractUsage(
  responseData: Record<string, unknown>,
): { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number } {
  const usage = responseData['usage'] as Record<string, number> | undefined;
  if (!usage) return {};

  // DeepSeek / OpenAI-compatible format
  const prompt = usage['prompt_tokens'] || usage['input_tokens'];
  const completion = usage['completion_tokens'] || usage['output_tokens'];
  const total = usage['total_tokens'] || (prompt && completion ? prompt + completion : undefined);
  const cached = usage['prompt_cache_hit_tokens'] || usage['cache_read_input_tokens'];

  return {
    promptTokens: prompt || undefined,
    completionTokens: completion || undefined,
    totalTokens: total || undefined,
    cachedTokens: cached || undefined,
  };
}

/**
 * Get the latest log file path for viewing.
 */
export function getTodayLogPath(): string {
  return todayFile();
}
