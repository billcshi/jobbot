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

interface Config {
  api_keys: {
    deepseek: string;
    anthropic: string;
  };
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const defaults: Config = {
    api_keys: {
      deepseek: '',
      anthropic: '',
    },
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
      },
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
  return config.api_keys.anthropic || process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN'] || '';
}

/** Reload config (useful after editing via web UI). */
export function reloadConfig(): void {
  cachedConfig = null;
}
