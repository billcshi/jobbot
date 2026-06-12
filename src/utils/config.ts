/**
 * Local configuration reader.
 *
 * Reads from local/config.yaml (gitignored) with env var fallback.
 * On first run, local/config.yaml is created from local.example/config.yaml
 * by `pnpm jobbot init-db`.
 */
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { LOCAL_DIR } from './paths.js';

const CONFIG_PATH = `${LOCAL_DIR}/config.yaml`;

/**
 * Per-operation thinking mode override.
 * - 'enabled': force thinking on (chain-of-thought reasoning before response)
 * - 'disabled': force thinking off (faster, cheaper, no reasoning tokens)
 * - 'auto': enabled for heavy models (v4-pro), disabled for flash
 */
export type ThinkingMode = 'enabled' | 'disabled' | 'auto';

export interface DeepseekThinkingConfig {
  /** Default thinking mode for operations without a specific override. */
  default: ThinkingMode;
  /** Per-operation overrides. Key = operation name (score, extract, customize, cover-letter, audit-content). */
  operations?: Record<string, ThinkingMode>;
}

export interface ConcurrencyConfig {
  /**
   * Maximum total concurrent tasks across all users.
   * PipelineManager refuses new pipelines when active tasks would exceed this.
   * Default: 50.
   */
  global: number;
  /**
   * Maximum concurrent jobs per user pipeline.
   * Each user's asyncPool uses this as the concurrency cap.
   * Default: 10.
   */
  per_user: number;
  /**
   * Per-stage concurrency overrides (optional).
   * If not set, per_user is used for all stages.
   * Stages that call external commands (pdflatex) should have lower limits.
   */
  stages?: {
    extract?: number;
    score?: number;
    compose?: number;
    audit?: number;
  };
}

interface Config {
  api_keys: {
    deepseek: string;
    anthropic: string;
    openai: string;
  };
  deepseek_model: string;
  /** DeepSeek thinking mode configuration. */
  deepseek_thinking?: DeepseekThinkingConfig;
  /** Concurrency limits for pipeline execution. */
  concurrency?: ConcurrencyConfig;
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const defaults: Config = {
    api_keys: {
      deepseek: '',
      anthropic: '',
      openai: '',
    },
    deepseek_model: 'deepseek-v4-pro',
  };

  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = defaults;
    return defaults;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = yaml.load(raw) as Partial<Config>;
    cachedConfig = {
      api_keys: {
        deepseek: parsed?.api_keys?.deepseek || '',
        anthropic: parsed?.api_keys?.anthropic || '',
        openai: parsed?.api_keys?.openai || '',
      },
      deepseek_model: parsed?.deepseek_model || 'deepseek-v4-pro',
      deepseek_thinking: parsed?.deepseek_thinking as DeepseekThinkingConfig | undefined,
      concurrency: parsed?.concurrency as ConcurrencyConfig | undefined,
    };
  } catch {
    cachedConfig = defaults;
  }

  return cachedConfig;
}

/**
 * Get the DeepSeek API key.
 * Checks: local/config.yaml → ANTHROPIC_AUTH_TOKEN env var
 */
export function getDeepseekKey(): string {
  const config = loadConfig();
  return config.api_keys.deepseek || process.env['ANTHROPIC_AUTH_TOKEN'] || '';
}

/**
 * Get the Anthropic (Claude) API key.
 * Checks: local/config.yaml → ANTHROPIC_API_KEY env var → ANTHROPIC_AUTH_TOKEN fallback
 */
export function getAnthropicKey(): string {
  const config = loadConfig();
  return config.api_keys.anthropic || process.env['ANTHROPIC_API_KEY'] || '';
}

/**
 * Get the OpenAI API key.
 * Checks: local/config.yaml → OPENAI_API_KEY env var
 */
export function getOpenAIKey(): string {
  const config = loadConfig();
  return config.api_keys.openai || process.env['OPENAI_API_KEY'] || '';
}

/**
 * Get the DeepSeek model name.
 * Defaults to 'deepseek-v4-pro'. Set `deepseek_model` in local/config.yaml
 * to use a different model (e.g., 'deepseek-v4-flash' for faster/cheaper).
 */
export function getDeepseekModel(): string {
  const config = loadConfig();
  return config.deepseek_model || 'deepseek-v4-pro';
}

/** Default thinking config: disabled for scoring (flash), enabled for heavy ops (pro). */
const DEFAULT_THINKING: DeepseekThinkingConfig = {
  default: 'auto',
  operations: {
    score: 'disabled',       // flash model, scoring is straightforward
    extract: 'disabled',     // structured extraction, no reasoning needed
    customize: 'enabled',       // complex resume customization benefits from reasoning
    'cover-letter': 'enabled', // creative writing benefits from reasoning
    'audit-ats-screener': 'enabled',
    'audit-hiring-manager': 'enabled',
    'audit-format-reviewer': 'enabled',
  },
};

/**
 * Resolve the thinking mode for a given operation.
 *
 * Resolution order: operation-specific override → configured default → hardcoded default.
 * Returns the `thinking` param to include in the DeepSeek request body,
 * or undefined if thinking should be left at the API default.
 */
export function getDeepseekThinking(operation: string): { type: string } | undefined {
  const config = loadConfig();
  const thinking = config.deepseek_thinking;
  if (!thinking) {
    // No user config — use hardcoded defaults
    const opMode = DEFAULT_THINKING.operations?.[operation];
    if (opMode === 'disabled') return { type: 'disabled' };
    if (opMode === 'enabled') return { type: 'enabled' };
    // auto: let the model decide (don't send thinking param)
    return undefined;
  }

  // User has thinking config — resolve per-operation
  const opMode = thinking.operations?.[operation] ?? thinking.default;
  if (opMode === 'disabled') return { type: 'disabled' };
  if (opMode === 'enabled') return { type: 'enabled' };
  // auto: don't send thinking param (API default)
  return undefined;
}

/** Default concurrency: 50 global, 10 per-user, lower limits for pdflatex stages. */
const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  global: 50,
  per_user: 10,
  stages: {
    compose: 5,   // pdflatex is CPU-heavy
    audit: 5,     // pdflatex + vision API
  },
};

/**
 * Get the concurrency configuration.
 * Merges user config with defaults.
 */
export function getConcurrency(): ConcurrencyConfig {
  const config = loadConfig();
  const user = config.concurrency;
  if (!user) return DEFAULT_CONCURRENCY;

  return {
    global: user.global ?? DEFAULT_CONCURRENCY.global,
    per_user: user.per_user ?? DEFAULT_CONCURRENCY.per_user,
    stages: {
      extract: user.stages?.extract ?? DEFAULT_CONCURRENCY.stages?.extract,
      score: user.stages?.score ?? DEFAULT_CONCURRENCY.stages?.score,
      compose: user.stages?.compose ?? DEFAULT_CONCURRENCY.stages?.compose ?? DEFAULT_CONCURRENCY.per_user,
      audit: user.stages?.audit ?? DEFAULT_CONCURRENCY.stages?.audit ?? DEFAULT_CONCURRENCY.per_user,
    },
  };
}

/**
 * Get the per-user concurrency for a specific pipeline stage.
 * Falls back to per_user if no stage-specific override is set.
 */
export function getStageConcurrency(stage: 'extract' | 'score' | 'compose' | 'audit'): number {
  const c = getConcurrency();
  return c.stages?.[stage] ?? c.per_user;
}

/** Reload config (useful after editing via web UI). */
export function reloadConfig(): void {
  cachedConfig = null;
}
