/** Throw a consistent AbortError at terminal write boundaries. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  throw error;
}

/** Preserve cancellation instead of translating it into an ordinary failure. */
export function rethrowAbort(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    if (error instanceof Error) throw error;
    throwIfAborted(signal);
  }
}
