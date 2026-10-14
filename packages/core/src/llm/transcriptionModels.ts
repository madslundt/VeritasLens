import { isCustomSttHost, normalizeOpenAiBaseUrl, STT_MODELS_BY_HOST } from '@/types';
import { fetchWithEndpointFallback } from '@/llm/endpointFallback';
import { UploadTimeoutError, withFetchTimeout } from '@/llm/fetchTimeout';

const MODEL_LIST_TIMEOUT_MS = 30_000;

/** Whisper servers may expose the OpenAI-compatible /models catalog.
 * Custom IDs are not filtered by name: they need not contain "whisper".
 * Servers without discovery return an empty list; manual entry still works.
 */
export async function fetchTranscriptionModels(
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  fallbackUrls?: readonly string[],
): Promise<string[]> {
  baseUrl = normalizeOpenAiBaseUrl(baseUrl);
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (!isCustomSttHost(baseUrl)) return [...(STT_MODELS_BY_HOST[baseUrl] ?? [])];

  const attempt = withFetchTimeout(signal, MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetchWithEndpointFallback({
      apiKey, baseUrl, fallbackUrls, path: '/models', init: { signal: attempt.signal },
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) return [];
    if (!response.ok) throw new Error(`Model listing HTTP ${response.status}. Enter a model ID manually or check the server configuration.`);
    const payload: unknown = await response.json();
    const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : undefined;
    if (!Array.isArray(data)) return [];
    const ids = data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return [];
      return entry.id.trim() ? [entry.id.trim()] : [];
    });
    return [...new Set(ids)].sort();
  } catch (error) {
    if (!signal?.aborted && attempt.timedOut()) throw new UploadTimeoutError('Whisper model loading timed out. You can enter a model ID manually.');
    throw error;
  } finally {
    attempt.cleanup();
  }
}
