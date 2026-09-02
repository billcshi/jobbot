/** Parse a browser/fetch URL while rejecting executable and non-web schemes. */
export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string): boolean {
  return parseHttpUrl(value) !== null;
}
