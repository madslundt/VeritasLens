import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenAiLens, callOpenAiLensStream, transcribeAudio } from '../src/llm/openai';
import { callLens, callLensStream } from '../src/llm/gemini';
import { encodePcmToWav } from '../src/runtime/audioBuffer';
import * as flacEncoder from '../src/runtime/flac';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const wav = encodePcmToWav(new Uint8Array(32_000), { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
const options = { apiKey: 'speech-key', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', wav, audioCompressionEnabled: true };
const success = () => new Response(JSON.stringify({ text: 'What is the capital of Denmark?' }), { status: 200 });
const fileFrom = (init?: RequestInit) => (init!.body as FormData).get('file') as File;

describe('compressed transcription uploads', () => {
  it.each([
    ['https://api.openai.com/v1', 'whisper-1'],
    ['https://api.openai.com/v1', 'gpt-4o-mini-transcribe'],
    ['https://api.groq.com/openai/v1', 'whisper-large-v3-turbo'],
  ])('uploads a smaller FLAC to %s with matching metadata (%s)', async (baseUrl, model) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init!.body as FormData;
      const file = fileFrom(init);
      expect(file.name).toBe('audio.flac');
      expect(file.type).toBe('audio/flac');
      expect(file.size).toBeLessThan(wav.length);
      expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 4))).toBe('fLaC');
      expect(form.get('model')).toBe(model);
      expect(form.get('response_format')).toBe('json');
      return success();
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await transcribeAudio({ ...options, baseUrl, model })).toContain('Denmark');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uploads the exact WAV and never invokes the encoder when compression is off', async () => {
    const encoder = vi.spyOn(flacEncoder, 'encodeWavToFlac');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const file = fileFrom(init);
      expect(file.name).toBe('audio.wav');
      expect(file.type).toBe('audio/wav');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav);
      return success();
    }));
    await transcribeAudio({ ...options, audioCompressionEnabled: false });
    expect(encoder).not.toHaveBeenCalled();
  });

  it('does not apply a model rejection to a different model or server', async () => {
    const uploads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      uploads.push(fileFrom(init).name);
      return uploads.length === 1 ? new Response('Unsupported FLAC codec', { status: 400 }) : success();
    }));
    const opts = { ...options, baseUrl: 'https://mixed-formats.example/v1' };
    await transcribeAudio(opts);
    await transcribeAudio({ ...opts, model: 'new-whisper' });
    await transcribeAudio({ ...opts, baseUrl: 'https://other-server.example/v1' });
    await transcribeAudio(opts);
    expect(uploads).toEqual(['audio.flac', 'audio.wav', 'audio.flac', 'audio.flac', 'audio.wav']);
  });

  it.each([415, 400, 422])('retries an explicit format rejection (%i) with WAV and remembers the host', async status => {
    const uploads: File[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      uploads.push(fileFrom(init));
      return uploads.length === 1
        ? new Response('Unsupported audio format: FLAC', { status }) : success();
    }));
    const opts = { ...options, baseUrl: `https://wav-only-${status}.example/v1` };
    await transcribeAudio(opts);
    await transcribeAudio(opts);
    expect(uploads.map(file => file.name)).toEqual(['audio.flac', 'audio.wav', 'audio.wav']);
    expect(new Uint8Array(await uploads[1]!.arrayBuffer())).toEqual(wav);
  });

  it.each([400, 401, 429, 500])('does not retry an unrelated server error (%i) with another upload', async status => {
    const fetchMock = vi.fn(async () => new Response('Invalid model or unavailable service', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeAudio(options)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not re-upload WAV after a dropped connection', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeAudio(options)).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not upload after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeAudio({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains WAV when compression is unavailable', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      expect(fileFrom(init).name).toBe('audio.wav');
      expect(fileFrom(init).size).toBe(wav.length);
      return success();
    }));
    await transcribeAudio(options);
  });
});

const lensOptions = { apiKey: 'test-key', wav, prompt: 'Answer.', schema: { type: 'object', properties: {} } };

describe.each([false, true])('Gemini audio uploads (streaming=%s)', streaming => {
  const call = streaming ? callLensStream : callLens;
  const response = () => {
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"Copenhagen"}' }] } }] });
    return new Response(streaming ? `data: ${json}\n\n` : json, { status: 200 });
  };

  it.each([false, true])('uses matching audio bytes and MIME type with compression=%s', async enabled => {
    const encoder = vi.spyOn(flacEncoder, 'encodeWavToFlac');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const audio = body.contents[0].parts[1].inlineData;
      const bytes = Buffer.from(audio.data, 'base64');
      expect(audio.mimeType).toBe(enabled ? 'audio/flac' : 'audio/wav');
      expect(bytes.subarray(0, 4).toString()).toBe(enabled ? 'fLaC' : 'RIFF');
      if (enabled) expect(bytes.length).toBeLessThan(wav.length);
      else expect(new Uint8Array(bytes)).toEqual(wav);
      return response();
    }));
    expect(await call({ ...lensOptions, audioCompressionEnabled: enabled })).toContain('Copenhagen');
    expect(encoder).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it('uses WAV when the encoder is unavailable', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).contents[0].parts[1].inlineData.mimeType).toBe('audio/wav');
      return response();
    }));
    await call({ ...lensOptions, audioCompressionEnabled: true });
  });
});

describe.each([false, true])('OpenRouter inline audio (streaming=%s)', streaming => {
  it('keeps WAV even with compression enabled because format support varies by model', async () => {
    const encoder = vi.spyOn(flacEncoder, 'encodeWavToFlac');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const user = body.messages.find((message: { role: string }) => message.role === 'user');
      const audio = user.content.find((part: { type: string }) => part.type === 'input_audio').input_audio;
      expect(audio.format).toBe('wav');
      expect(new Uint8Array(Buffer.from(audio.data, 'base64'))).toEqual(wav);
      const content = '{"answer":"Copenhagen"}';
      return new Response(streaming
        ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const call = streaming ? callOpenAiLensStream : callOpenAiLens;
    await call({ ...lensOptions, baseUrl: 'https://openrouter.ai/api/v1', model: 'audio-model', audioCompressionEnabled: true });
    expect(encoder).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
