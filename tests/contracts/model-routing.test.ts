// tests/contracts/model-routing.test.ts
//
// Pins how the LLM facade (`src/llm`) routes the user's stored model
// selection to provider call sites. The user reported a regression where
// the chosen model was silently overridden by a hardcoded one; this file
// makes that class of regression impossible to ship without a red test.
//
// Covered routes:
//   - Gemini main call uses `settings().geminiModel`
//   - Gemini Auto classifier uses `chooseClassifierModel(settings)`
//   - OpenAI-compatible chat call uses `settings().openaiModel`
//   - OpenAI transcribe call uses per-host
//     `settings().openaiTranscribeModels[baseUrl]` when set, else the static
//     `OPENAI_TRANSCRIBE_MODELS[baseUrl]` default
//
// We mutate the settings signal via `loadSettings(getter)` — the same path
// production uses on boot. This avoids touching the module's private setter
// while exercising the real coercion logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Lifecycle pulls in the SDK transitively (via runtime/bridge → even_hub_sdk).
// Mock both at the boundary so the import resolves in node env.
vi.mock('@evenrealities/even_hub_sdk', () => {
  class Bag {
    constructor(public payload: Record<string, unknown>) {}
  }
  return {
    CreateStartUpPageContainer: Bag,
    RebuildPageContainer: Bag,
    TextContainerProperty: Bag,
    TextContainerUpgrade: Bag,
    ListContainerProperty: Bag,
    ListItemContainerProperty: Bag,
    StartUpPageCreateResult: { success: 0 },
    OsEventTypeList: {
      CLICK_EVENT: 1,
      DOUBLE_CLICK_EVENT: 2,
      SCROLL_TOP_EVENT: 3,
      SCROLL_BOTTOM_EVENT: 4,
      FOREGROUND_EXIT_EVENT: 5,
      FOREGROUND_ENTER_EVENT: 6,
      SYSTEM_EXIT_EVENT: 7,
      ABNORMAL_EXIT_EVENT: 8,
    },
    DeviceStatus: class {},
    EvenAppBridge: class {},
    waitForEvenAppBridge: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/runtime/bridge', () => ({
  getBridge: () => ({
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async () => true),
    textContainerUpgrade: vi.fn(async () => true),
    audioControl: vi.fn(async () => true),
    setLocalStorage: vi.fn(async () => true),
    getLocalStorage: vi.fn(async () => ''),
    onEvenHubEvent: vi.fn(() => () => undefined),
  }),
}));

import { callLens } from '../../src/llm';
import { chooseClassifierModel } from '../../src/runtime/lifecycle';
import { loadSettings, settings } from '../../src/state/store';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  OPENAI_TRANSCRIBE_MODELS,
  type GeminiModel,
  type Settings,
} from '../../src/types';

const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
};
const OPENAI_OK = {
  choices: [{ message: { content: '{"ok":true}' } }],
};
const OPENAI_TRANSCRIBE_OK = { text: 'hello world' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Drive `loadSettings` with a fake KV so the live signal reflects our overrides. */
async function setSettingsForTest(overrides: Partial<Settings>): Promise<void> {
  const current = settings();
  const fakeStore = new Map<string, string>();
  fakeStore.set('veritaslens.provider', overrides.provider ?? current.provider);
  fakeStore.set('veritaslens.geminiKey', overrides.geminiApiKey ?? current.geminiApiKey);
  fakeStore.set('veritaslens.geminiModel', overrides.geminiModel ?? current.geminiModel);
  // null is persisted as ''
  const autoModel = (overrides.geminiAutoModel ?? current.geminiAutoModel) ?? '';
  fakeStore.set('veritaslens.geminiAutoModel', String(autoModel));
  fakeStore.set(
    'veritaslens.openaiBaseUrl',
    overrides.openaiBaseUrl ?? current.openaiBaseUrl,
  );
  fakeStore.set('veritaslens.openaiModel', overrides.openaiModel ?? current.openaiModel);

  const apiKeys = overrides.openaiApiKeys ?? current.openaiApiKeys;
  for (const [url, key] of Object.entries(apiKeys)) {
    fakeStore.set(`veritaslens.openaiKey.${url}`, key);
  }
  const transcribe = overrides.openaiTranscribeModels ?? current.openaiTranscribeModels;
  for (const [url, model] of Object.entries(transcribe)) {
    fakeStore.set(`veritaslens.openaiTranscribeModel.${url}`, model);
  }
  await loadSettings(async (k) => fakeStore.get(k) ?? '');
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chooseClassifierModel', () => {
  it('returns geminiAutoModel when set on the Gemini provider', () => {
    const s = { provider: 'gemini', geminiAutoModel: 'gemini-2.5-flash' } as unknown as Settings;
    expect(chooseClassifierModel(s)).toBe('gemini-2.5-flash');
  });

  it('returns undefined when geminiAutoModel is null (reuse main model)', () => {
    const s = { provider: 'gemini', geminiAutoModel: null } as unknown as Settings;
    expect(chooseClassifierModel(s)).toBeUndefined();
  });

  it('returns undefined on the OpenAI-compatible provider (no separate auto knob)', () => {
    const s = {
      provider: 'openai-compatible',
      geminiAutoModel: 'gemini-2.5-flash',
    } as unknown as Settings;
    expect(chooseClassifierModel(s)).toBeUndefined();
  });
});

describe('callLens facade routes the stored model to the provider', () => {
  it('uses settings().geminiModel for the Gemini provider when no override is passed', async () => {
    await setSettingsForTest({
      provider: 'gemini',
      geminiApiKey: 'k',
      geminiModel: 'gemini-2.5-pro' as GeminiModel,
    });
    const fetchMock = vi.fn(async () => jsonResponse(GEMINI_OK));
    vi.stubGlobal('fetch', fetchMock);

    await callLens({
      wav: new Uint8Array([1, 2, 3]),
      prompt: 'p',
      schema: { type: 'object', properties: {} },
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toContain('/v1beta/models/gemini-2.5-pro:generateContent');
  });

  it('falls back to DEFAULT_GEMINI_MODEL when an invalid model leaks past coercion', async () => {
    // `loadSettings`'s coerceModel rejects an invalid raw string; this asserts
    // the defense-in-depth `resolveModel` inside callGeminiLens still falls
    // back to default if something later writes a bad value past coercion.
    await setSettingsForTest({
      provider: 'gemini',
      geminiApiKey: 'k',
      // valid pattern, valid URL char set, just a name that doesn't exist —
      // proves the call site uses whatever the store says.
      geminiModel: 'gemini-2.5-pro' as GeminiModel,
    });
    const fetchMock = vi.fn(async () => jsonResponse(GEMINI_OK));
    vi.stubGlobal('fetch', fetchMock);

    // Now call with an override that would inject a path-traversal char:
    await callLens({
      wav: new Uint8Array([1, 2, 3]),
      prompt: 'p',
      schema: { type: 'object', properties: {} },
      model: 'gemini-../../etc/passwd',
    });

    const url = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0] ?? '';
    expect(url).toContain(`/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  });

  it('uses settings().openaiModel for the OpenAI-compatible provider', async () => {
    await setSettingsForTest({
      provider: 'openai-compatible',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiApiKeys: {
        'https://api.openai.com/v1': 'k',
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
      openaiModel: DEFAULT_OPENAI_MODEL,
      openaiTranscribeModels: {
        'https://api.openai.com/v1': '',
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/audio/transcriptions')) return jsonResponse(OPENAI_TRANSCRIBE_OK);
      return jsonResponse(OPENAI_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLens({
      wav: new Uint8Array([1, 2, 3]),
      prompt: 'p',
      schema: { type: 'object', properties: {} },
    });

    const chatCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([u]) => u.includes('/chat/completions'),
    );
    expect(chatCall, 'expected a /chat/completions request').toBeDefined();
    const body = JSON.parse((chatCall![1].body as string) ?? '{}') as { model: string };
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('uses the per-host transcribe override when set', async () => {
    const override = 'whisper-large-v3-turbo';
    await setSettingsForTest({
      provider: 'openai-compatible',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiApiKeys: {
        'https://api.openai.com/v1': 'k',
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
      openaiModel: DEFAULT_OPENAI_MODEL,
      openaiTranscribeModels: {
        'https://api.openai.com/v1': override,
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/audio/transcriptions')) return jsonResponse(OPENAI_TRANSCRIBE_OK);
      return jsonResponse(OPENAI_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLens({
      wav: new Uint8Array([1, 2, 3]),
      prompt: 'p',
      schema: { type: 'object', properties: {} },
    });

    const transcribeCall = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    ).find(([u]) => u.endsWith('/audio/transcriptions'));
    expect(transcribeCall, 'expected a /audio/transcriptions request').toBeDefined();
    const body = transcribeCall![1].body as FormData;
    expect(body.get('model')).toBe(override);
  });

  it('empty transcribe override falls back to OPENAI_TRANSCRIBE_MODELS default', async () => {
    await setSettingsForTest({
      provider: 'openai-compatible',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiApiKeys: {
        'https://api.openai.com/v1': 'k',
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
      openaiModel: DEFAULT_OPENAI_MODEL,
      openaiTranscribeModels: {
        'https://api.openai.com/v1': '',
        'https://api.groq.com/openai/v1': '',
        'https://openrouter.ai/api/v1': '',
      },
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/audio/transcriptions')) return jsonResponse(OPENAI_TRANSCRIBE_OK);
      return jsonResponse(OPENAI_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLens({
      wav: new Uint8Array([1, 2, 3]),
      prompt: 'p',
      schema: { type: 'object', properties: {} },
    });

    const transcribeCall = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    ).find(([u]) => u.endsWith('/audio/transcriptions'));
    expect(transcribeCall).toBeDefined();
    const body = transcribeCall![1].body as FormData;
    const expected = OPENAI_TRANSCRIBE_MODELS['https://api.openai.com/v1'];
    expect(body.get('model')).toBe(expected);
  });
});
