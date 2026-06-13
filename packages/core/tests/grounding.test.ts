import { describe, expect, it } from 'vitest';
import { applyModelGrounding, resolveProviderGrounding } from '@/llm/tools';

describe('resolveProviderGrounding', () => {
  it('returns no-op result with mode grounded when grounding is undefined', () => {
    const r = resolveProviderGrounding('gemini', undefined, undefined, 'gemini-2.5-flash');
    expect(r.mode).toBe('grounded');
    expect(r.tools).toBeUndefined();
    expect(r.modelOverride).toBeUndefined();
    expect(r.modelSuffix).toBeUndefined();
  });

  describe('gemini', () => {
    it('emits the google_search tool', () => {
      const r = resolveProviderGrounding('gemini', undefined, 'web_search', 'gemini-2.5-flash');
      expect(r.mode).toBe('grounded');
      expect(r.tools).toEqual([{ google_search: {} }]);
    });

    it('back-compat: legacy "google_search" intent also grounds', () => {
      const r = resolveProviderGrounding('gemini', undefined, 'google_search', 'gemini-2.5-flash');
      expect(r.mode).toBe('grounded');
      expect(r.tools).toBeDefined();
    });
  });

  describe('claude', () => {
    it('emits the web_search_20250305 tool', () => {
      const r = resolveProviderGrounding('claude', undefined, 'web_search', 'claude-sonnet-4-6');
      expect(r.mode).toBe('grounded');
      expect(r.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ]);
    });
  });

  describe('openai-compatible', () => {
    it('groundless on OpenAI', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://api.openai.com/v1',
        'web_search',
        'gpt-4o-mini',
      );
      expect(r.mode).toBe('groundless');
      expect(r.tools).toBeUndefined();
    });

    it('groundless on Groq', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://api.groq.com/openai/v1',
        'web_search',
        'llama-3.3-70b',
      );
      expect(r.mode).toBe('groundless');
    });

    it('groundless on DeepSeek', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://api.deepseek.com/v1',
        'web_search',
        'deepseek-chat',
      );
      expect(r.mode).toBe('groundless');
    });

    it('grounded on OpenRouter via :online suffix when model lacks it', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://openrouter.ai/api/v1',
        'web_search',
        'openai/gpt-4o',
      );
      expect(r.mode).toBe('grounded');
      expect(r.modelSuffix).toBe(':online');
      expect(r.modelOverride).toBeUndefined();
    });

    it('grounded on OpenRouter without suffix when model already has :online', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://openrouter.ai/api/v1',
        'web_search',
        'openai/gpt-4o:online',
      );
      expect(r.mode).toBe('grounded');
      expect(r.modelSuffix).toBeUndefined();
    });

    it('grounded on Perplexity via sonar-pro override when model is not sonar', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://api.perplexity.ai',
        'web_search',
        'llama-3-instruct',
      );
      expect(r.mode).toBe('grounded');
      expect(r.modelOverride).toBe('sonar-pro');
    });

    it('grounded on Perplexity without override when model already sonar-*', () => {
      const r = resolveProviderGrounding(
        'openai-compatible',
        'https://api.perplexity.ai',
        'web_search',
        'sonar-reasoning',
      );
      expect(r.mode).toBe('grounded');
      expect(r.modelOverride).toBeUndefined();
    });
  });
});

describe('applyModelGrounding', () => {
  it('returns baseModel when no override or suffix', () => {
    expect(applyModelGrounding('gpt-4o', { mode: 'grounded' })).toBe('gpt-4o');
  });

  it('returns modelOverride when set', () => {
    expect(
      applyModelGrounding('llama-3', { mode: 'grounded', modelOverride: 'sonar-pro' }),
    ).toBe('sonar-pro');
  });

  it('appends modelSuffix', () => {
    expect(
      applyModelGrounding('openai/gpt-4o', { mode: 'grounded', modelSuffix: ':online' }),
    ).toBe('openai/gpt-4o:online');
  });

  it('does not double-append modelSuffix', () => {
    expect(
      applyModelGrounding('openai/gpt-4o:online', {
        mode: 'grounded',
        modelSuffix: ':online',
      }),
    ).toBe('openai/gpt-4o:online');
  });
});
