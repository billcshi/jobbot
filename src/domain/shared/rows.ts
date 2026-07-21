/** Runtime guards for values returned from better-sqlite3. */
export function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Database column ${key} must be a number`);
  }
  return value;
}

export function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Database column ${key} must be a string`);
  return value;
}

export function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Database column ${key} must be a number or null`);
  }
  return value;
}

export function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Database column ${key} must be a string or null`);
  return value;
}
