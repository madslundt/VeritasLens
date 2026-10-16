import { settings } from '@/state/store';
import { transcribeAudio } from '@/llm/openai';
import { defaultSttModel, isCustomSttHost } from '@/types';
import { encodePcmToWav } from './audioBuffer';

export function captionConfigurationError(): string | null {
  const s = settings();
  return !isCustomSttHost(s.sttHost) && !(s.openaiApiKeys[s.sttHost] ?? '').trim()
    ? 'Configure a speech-to-text host and key in AI setup to use live captions.' : null;
}
export async function transcribeConversationAudio(wav: Uint8Array, signal: AbortSignal): Promise<string> {
  const s = settings();
  const error = captionConfigurationError();
  if (error) throw new Error(error);
  return transcribeAudio({ apiKey: s.openaiApiKeys[s.sttHost] ?? '', baseUrl: s.sttHost,
    audioCompressionEnabled: s.audioCompressionEnabled ?? true,
    fallbackUrls: s.sttFallbackUrls?.[s.sttHost], model: s.sttModel || defaultSttModel(s.sttHost), wav, signal });
}

/** Bounded, non-overlapping caption requests. stop() invalidates even providers that ignore abort. */
export class LiveCaptionCapture {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private cursor = 0;
  constructor(private options: {
    source: (cursor: number) => { pcm: Uint8Array; sampleRate: number; endOffset: number } | null;
    onCaption: (text: string, startedAt: number, endedAt: number) => void;
    onError: (message: string) => void;
    transcribe?: typeof transcribeConversationAudio;
    intervalMs?: number;
  }) {}
  start(cursor = 0): void { this.stop(); this.cursor = cursor; const gen = this.generation; this.schedule(gen); }
  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(); this.controller = null;
  }
  private schedule(gen: number): void {
    this.timer = setTimeout(() => { this.timer = null; void this.tick(gen); }, this.options.intervalMs ?? 4000);
  }
  private async tick(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const source = this.options.source(this.cursor);
    if (!source) { this.schedule(gen); return; }
    const bytesPerSec = source.sampleRate * 2;
    if (source.pcm.length < bytesPerSec / 2) { this.schedule(gen); return; }
    const endedAt = Date.now();
    const pcm = source.pcm.subarray(Math.max(0, source.pcm.length - bytesPerSec * 15));
    if (pcm.length < source.pcm.length) this.options.onError('Some speech was skipped while captions caught up.');
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      // Skip quiet chunks locally before uploading; a transcriber still handles unclear speech.
      const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let energy = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) energy += samples.getInt16(i, true) ** 2;
      if (Math.sqrt(energy / Math.max(1, pcm.length / 2)) < 50) { this.cursor = source.endOffset; return; }
      const wav = encodePcmToWav(pcm, { sampleRate: source.sampleRate, bitsPerSample: 16, channels: 1 });
      const text = await (this.options.transcribe ?? transcribeConversationAudio)(wav, controller.signal);
      if (gen !== this.generation || controller.signal.aborted) return;
      this.cursor = source.endOffset;
      if (text.trim()) this.options.onCaption(text.trim(), endedAt - pcm.length / bytesPerSec * 1000, endedAt);
    } catch (error) {
      if (gen === this.generation) this.options.onError(controller.signal.aborted ? 'Captions timed out. Retrying.' : error instanceof Error ? error.message : 'Captions unavailable.');
    } finally {
      clearTimeout(timeout);
      if (gen === this.generation) { this.controller = null; this.schedule(gen); }
    }
  }
}
