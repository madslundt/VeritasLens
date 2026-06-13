import { EvenAppBridge, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { pushDebugEvent } from '@/state/store';

/**
 * Thin accessor around the SDK singleton.
 *
 * Holds a module-scoped reference once `init()` resolves so call sites can
 * avoid awaiting `waitForEvenAppBridge()` repeatedly.
 *
 * Also installs a wiretap on `window._listenEvenAppMessage` — the SDK's
 * one and only entry point for host → web messages. We log every single
 * incoming message regardless of whether the SDK manages to parse it
 * into a typed event. Critical for diagnosing missing-gesture issues
 * where the host's message format doesn't match the SDK's parser.
 */

let cached: EvenAppBridge | null = null;
let wiretapInstalled = false;

export async function initBridge(): Promise<EvenAppBridge> {
  if (cached) return cached;
  cached = await waitForEvenAppBridge();
  installRawMessageWiretap();
  return cached;
}

export function getBridge(): EvenAppBridge {
  if (!cached) {
    throw new Error('Bridge not initialized — call initBridge() before getBridge().');
  }
  return cached;
}

function installRawMessageWiretap(): void {
  if (wiretapInstalled) return;
  const w = window as unknown as {
    _listenEvenAppMessage?: (msg: unknown) => void;
  };
  const original = w._listenEvenAppMessage;
  if (typeof original !== 'function') {
    // SDK hasn't set up the hook yet (shouldn't happen post-waitFor, but
    // bail out silently rather than break the bridge).
    return;
  }
  w._listenEvenAppMessage = function (msg: unknown) {
    try {
      // Skip audio frames — they fire at 16 kHz and would drown out gestures.
      // Detect by sniffing the serialized payload for any audio-related key,
      // independent of the host's chosen wire shape.
      if (!isAudioMessage(msg)) {
        const method = (msg as { method?: string })?.method ?? 'unknown';
        if (import.meta.env.DEV) console.info('[veritaslens RAW]', msg);
        pushDebugEvent({
          label: method,
          detail: safeStringify(msg, 480),
        });
      }
    } catch {
      /* never let logging break the SDK */
    }
    return original.call(this, msg);
  };
  wiretapInstalled = true;
}

/**
 * The "audio" prefix anchored to the start of the string and followed by end,
 * `_` (snake_case like `audio_pcm`), or an uppercase letter (camelCase like
 * `audioFrame`). Avoids the previous `/audio/i` false-positive that matched
 * any substring — a URL or field name containing "audio" elsewhere would
 * have silently suppressed an unrelated debug event.
 */
const AUDIO_TYPE_PREFIX = /^audio(?:$|_|[A-Z])/;

export function isAudioMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  // Fast path: structured-type checks.
  const m = msg as { data?: unknown };
  const data = m.data;
  if (data) {
    if (Array.isArray(data)) {
      const head = data[0];
      if (typeof head === 'string' && AUDIO_TYPE_PREFIX.test(head)) return true;
    } else if (typeof data === 'object') {
      const d = data as { type?: unknown };
      if (typeof d.type === 'string' && AUDIO_TYPE_PREFIX.test(d.type)) return true;
    }
  }
  // Fallback: any serialized payload containing an audio-PCM field is audio.
  // Bound the stringify length — large audio payloads are exactly what we
  // want to filter cheaply.
  try {
    const head = JSON.stringify(msg)?.slice(0, 200) ?? '';
    if (/"audio_?pcm"/i.test(head)) return true;
    if (/"audio_?event"/i.test(head)) return true;
  } catch {
    /* ignored */
  }
  return false;
}

function safeStringify(value: unknown, max: number): string {
  try {
    const s = JSON.stringify(value);
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return String(value).slice(0, max);
  }
}
