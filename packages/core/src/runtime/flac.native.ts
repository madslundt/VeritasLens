import { throwIfAborted } from '@/llm/fetchTimeout';

/** Hermes has no WebAssembly runtime. Keep WAV until a native encoder is available. */
export async function encodeWavToFlac(_wav: Uint8Array, signal?: AbortSignal): Promise<Uint8Array | null> {
  throwIfAborted(signal);
  return null;
}
