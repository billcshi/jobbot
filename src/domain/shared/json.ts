/** Values that can be persisted as JSON without losing type information. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Validate and clone an unknown value into the JSON domain.
 *
 * JSON.stringify silently drops unsupported values. Persistence code should
 * fail instead, so corrupt AI output cannot become canonical state.
 */
export function toJsonValue(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item, `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`${path} contains a value that JSON cannot represent`);
}

export function toJsonObject(value: unknown, label = 'value'): JsonObject {
  const normalized = toJsonValue(value, label);
  if (!isRecord(normalized)) throw new Error(`${label} must be an object`);
  return normalized;
}

export function parseJsonValue(raw: string, label = 'stored JSON'): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return toJsonValue(parsed, label);
}

export function parseJsonObject(raw: string, label = 'stored JSON'): JsonObject {
  return toJsonObject(parseJsonValue(raw, label), label);
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
