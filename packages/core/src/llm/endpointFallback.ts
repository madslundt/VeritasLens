import { normalizeOpenAiBaseUrl } from '@/types';
import { UploadTimeoutError } from '@/llm/fetchTimeout';

/** Deadline for reaching response headers before trying another address. */
export const ENDPOINT_HEADER_TIMEOUT_MS = 10_000;

export interface EndpointFallbackOptions {
  baseUrl: string;
  /** Alternative addresses for the same server, using the same key and model. */
  fallbackUrls?: readonly string[];
  apiKey: string;
  path: string;
  init: RequestInit;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function headerDeadline(outer: AbortSignal | null | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(outer?.reason);
  // Composed signals keep outer cancellation active after headers without
  // retaining an explicit listener. Older WebViews use a once-only listener.
  const composed = outer && typeof AbortSignal.any === 'function';
  const signal = composed ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  if (!composed) {
    if (outer?.aborted) forwardAbort();
    else outer?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ENDPOINT_HEADER_TIMEOUT_MS);
  const clearTimer = () => clearTimeout(timer);
  return {
    signal,
    timedOut: () => timedOut,
    clearTimer,
    dispose: () => {
      clearTimer();
      if (!composed) outer?.removeEventListener('abort', forwardAbort);
    },
  };
}

/**
 * Try equivalent server addresses in order before handing off a response.
 * Provider retry logic remains responsible for retrying the final failure;
 * a successfully opened stream is never replayed on another address.
 */
export async function fetchWithEndpointFallback({
  baseUrl, fallbackUrls = [], apiKey, path, init,
}: EndpointFallbackOptions): Promise<Response> {
  // Validate the entire list before sending credentials to any address.
  const addresses = [...new Set([baseUrl, ...fallbackUrls].map(normalizeOpenAiBaseUrl))];
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const requestHeaders = Object.fromEntries(headers.entries());
  const suffix = path.startsWith('/') ? path : `/${path}`;

  for (let index = 0; index < addresses.length; index++) {
    throwIfAborted(init.signal);
    const deadline = addresses.length > 1 ? headerDeadline(init.signal) : undefined;
    let response: Response;
    try {
      response = await fetch(`${addresses[index]}${suffix}`, {
        ...init, headers: requestHeaders, signal: deadline?.signal ?? init.signal,
      });
    } catch (error) {
      deadline?.dispose();
      throwIfAborted(init.signal);
      const failure = deadline?.timedOut()
        ? new UploadTimeoutError(`Endpoint response timed out after ${ENDPOINT_HEADER_TIMEOUT_MS / 1000}s.`)
        : error;
      if (index === addresses.length - 1) throw failure;
      continue;
    }
    deadline?.clearTimer();
    throwIfAborted(init.signal);
    const canFallback = response.status === 408 || response.status === 429
      || (response.status >= 500 && response.status < 600);
    if (!canFallback || index === addresses.length - 1) {
      // Keep outer cancellation connected to fetch while its body streams.
      return response;
    }
    deadline?.dispose();
    // Do not leave failed connections downloading while trying the next one.
    try { await response.body?.cancel(); } catch { /* discarding a failed response is best-effort */ }
  }
  throw new Error('No endpoint addresses configured.');
}
