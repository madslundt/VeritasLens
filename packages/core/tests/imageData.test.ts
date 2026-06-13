// tests/imageData.test.ts
//
// Verifies that imageData (base64 JPEG) is forwarded as an `inlineData` part
// in the Gemini request body when provided via CallLensOptions.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callLens } from '@/llm/gemini';

const OK_RESPONSE = {
  candidates: [{ content: { parts: [{ text: '{"verdict":"TRUE","claim":"x","reason":"y"}' }] } }],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const baseOpts = {
  apiKey: 'k',
  wav: new Uint8Array([1, 2, 3]),
  prompt: 'p',
  schema: { type: 'object', properties: {} },
};

describe('imageData in Gemini callLens', () => {
  it('includes image inlineData part when imageData is provided', async () => {
    let capturedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse(OK_RESPONSE);
    }));

    await callLens({ ...baseOpts, imageData: 'AAAA' });

    const parts = (capturedBody as { contents: Array<{ parts: unknown[] }> }).contents[0].parts;
    const imagePart = (parts as Array<{ inlineData?: { mimeType: string; data: string } }>)
      .find(p => p.inlineData?.mimeType === 'image/jpeg');
    expect(imagePart).toBeDefined();
    expect(imagePart!.inlineData!.data).toBe('AAAA');
  });

  it('does not include image inlineData part when imageData is absent', async () => {
    let capturedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse(OK_RESPONSE);
    }));

    await callLens({ ...baseOpts });

    const parts = (capturedBody as { contents: Array<{ parts: unknown[] }> }).contents[0].parts;
    const imagePart = (parts as Array<{ inlineData?: { mimeType: string } }>)
      .find(p => p.inlineData?.mimeType === 'image/jpeg');
    expect(imagePart).toBeUndefined();
  });
});
