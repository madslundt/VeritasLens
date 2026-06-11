// src/llm/tools.ts
//
// Provider-agnostic grounding resolver. A persona declares `grounding:
// 'web_search'` (intent only). This module maps that intent to whatever the
// active provider exposes:
//
//   - Gemini:        tools: [{ google_search: {} }]
//   - Claude:        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
//   - OpenRouter:    append ':online' suffix to the chosen model
//   - Perplexity:    swap to a `sonar-*` online model
//   - OpenAI:        no native chat-completion search → groundless
//   - Groq:          no native chat search → groundless
//   - DeepSeek:      no chat search → groundless
//
// When the provider can't ground, mode === 'groundless' so the HUD can render
// a small badge informing the wearer the answer came from training data.

import type {
  GroundingMode,
  LensGrounding,
  LlmProvider,
  OpenAiBaseUrl,
} from '@/types';

/** Anthropic's server-side web search tool spec — capped to 3 uses per call
 *  so a runaway model can't burn extra latency or cost on a single tap. */
const CLAUDE_WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
} as const;

/** Gemini's Google Search grounding tool. Same shape used to live in
 *  `gemini.ts` as `GOOGLE_SEARCH_TOOLS` — duplicated here as the single
 *  source of truth for the resolver. */
const GEMINI_GOOGLE_SEARCH_TOOL = { google_search: {} } as const;

/**
 * Default Perplexity online model when the user hasn't picked a sonar-* model
 * themselves. `sonar-pro` is the production sweet spot — fast, has online
 * search built in, supports tool calls.
 */
const PERPLEXITY_DEFAULT_ONLINE_MODEL = 'sonar-pro';

const OPENROUTER_ONLINE_SUFFIX = ':online';

export interface ProviderGroundingResult {
  /** Tools array to forward to the provider client. Gemini + Claude only. */
  tools?: unknown[];
  /** Replace the chosen model id outright. Used by Perplexity to swap into a sonar-* online model. */
  modelOverride?: string;
  /** Append to the chosen model id. Used by OpenRouter to enable ':online' search. */
  modelSuffix?: string;
  /** 'grounded' when any of the above is populated; 'groundless' otherwise. */
  mode: GroundingMode;
}

/**
 * Resolve a persona's `grounding` declaration to the provider-native shape.
 * When the persona didn't ask for grounding (input `grounding` undefined),
 * returns an empty result with mode `'grounded'` — `'groundless'` only
 * indicates that grounding was *requested* but the provider can't fulfil it,
 * not that this particular call ran without grounding.
 */
export function resolveProviderGrounding(
  provider: LlmProvider,
  baseUrl: OpenAiBaseUrl | undefined,
  grounding: LensGrounding | undefined,
  currentModel: string | undefined,
): ProviderGroundingResult {
  if (!grounding) {
    return { mode: 'grounded' };
  }
  if (provider === 'gemini') {
    return {
      tools: [GEMINI_GOOGLE_SEARCH_TOOL],
      mode: 'grounded',
    };
  }
  if (provider === 'claude') {
    return {
      tools: [CLAUDE_WEB_SEARCH_TOOL],
      mode: 'grounded',
    };
  }
  // openai-compatible — branch on host.
  switch (baseUrl) {
    case 'https://api.perplexity.ai': {
      const model = currentModel ?? '';
      if (model.startsWith('sonar')) {
        // User already picked a sonar-* model; it has online search built in.
        return { mode: 'grounded' };
      }
      return {
        modelOverride: PERPLEXITY_DEFAULT_ONLINE_MODEL,
        mode: 'grounded',
      };
    }
    case 'https://openrouter.ai/api/v1': {
      const model = currentModel ?? '';
      if (model.endsWith(OPENROUTER_ONLINE_SUFFIX)) {
        return { mode: 'grounded' };
      }
      return {
        modelSuffix: OPENROUTER_ONLINE_SUFFIX,
        mode: 'grounded',
      };
    }
    case 'https://api.openai.com/v1':
    case 'https://api.groq.com/openai/v1':
    case 'https://api.deepseek.com/v1':
    default:
      // No native chat-completions web search on these hosts. Mark groundless
      // so the HUD can flag it.
      return { mode: 'groundless' };
  }
}

/**
 * Apply the resolved grounding to a model id. Used by the OpenAI-compatible
 * client where the grounding mechanism is either an override or a suffix on
 * the model name itself.
 */
export function applyModelGrounding(
  baseModel: string,
  result: ProviderGroundingResult,
): string {
  if (result.modelOverride) return result.modelOverride;
  if (result.modelSuffix && !baseModel.endsWith(result.modelSuffix)) {
    return `${baseModel}${result.modelSuffix}`;
  }
  return baseModel;
}
