export interface JsonRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  label: string;
}

export interface JsonRequestResult<T> {
  data: T;
  durationMs: number;
}

function combinedSignal(callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
  if (!callerSignal) return timeoutSignal;
  const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (abortSignalWithAny.any) return abortSignalWithAny.any([callerSignal, timeoutSignal]);

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (callerSignal.aborted) abortFrom(callerSignal);
  else callerSignal.addEventListener('abort', () => abortFrom(callerSignal), { once: true });
  timeoutSignal.addEventListener('abort', () => abortFrom(timeoutSignal), { once: true });
  return controller.signal;
}

/** Fetch and decode one JSON response with a hard timeout and clear errors. */
export async function requestJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<JsonRequestResult<T>> {
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: combinedSignal(options.signal, timeoutSignal),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${options.label} API error ${response.status}: ${body.slice(0, 200)}`);
    }
    return {
      data: await response.json() as T,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new Error(`${options.label} timed out after ${options.timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}
