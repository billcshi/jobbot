import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/** Parse a YAML string into an object. */
export function parseYaml<T = unknown>(content: string): T {
  return yaml.load(content) as T;
}

/** Read and parse a YAML file. Returns `fallback` if the file is missing. */
export function readYamlFile<T = unknown>(filePath: string, fallback?: T): T {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return yaml.load(raw) as T;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      if (fallback !== undefined) return fallback;
      throw new Error(`Required YAML file not found: ${filePath}`);
    }
    throw err;
  }
}
