// src/llm/tools.ts
//
// Provider-agnostic grounding resolver. A persona declares `grounding:
// 'web_search'` (intent only). This module maps that intent to whatever the
// active provider exposes:
//
//   - Gemini:        tools: [{ google_search: {} }]
//   - Claude:        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
//   - OpenAI:        switch to /v1/responses with the built-in web_search tool
//                    (signalled by `useResponsesApi: true` so the facade
//                    dispatches to the Responses client instead of Chat
//                    Completions). Falls back to `groundless` if the chosen
//                    model doesn't accept the tool.
//   - OpenRouter:    append ':online' suffix to the chosen model
//   - Perplexity:    swap to a `sonar-*` online model
//   - Groq:          switch to a `groq/compound-*` model (Tavily-backed
//                    native web search) via modelOverride.
//   - DeepSeek:      no native chat search → pre-fetch via the wearer's
//                    Perplexity Search API key (`prefetchSearch: 'perplexity'`)
//                    and inject results into the prompt. Falls back to
//                    `groundless` when no Perplexity key is available — the
//                    facade decides which by inspecting settings.
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

/**
 * Default Groq compound model when the wearer hasn't picked one themselves.
 * `groq/compound` runs Tavily-backed web search transparently and returns the
 * `executed_tools[].search_results[]` array we parse for citations. The
 * `compound-mini` variant is cheaper but skips multi-hop search — sticking
 * with `compound` matches the production sweet spot for fact-style lenses.
 */
const GROQ_COMPOUND_MODEL = 'groq/compound';

/**
 * Models on OpenAI's Responses API that accept the built-in `web_search`
 * tool. Pattern-matched rather than enumerated so a new GPT-5 family release
 * works without a code change. The Chat Completions branch keeps running for
 * non-grounded calls regardless.
 */
const OPENAI_RESPONSES_WEB_SEARCH_PATTERN = /^gpt-(5|4\.1|4o)/i;

export interface ProviderGroundingResult {
  /** Tools array to forward to the provider client. Gemini + Claude only. */
  tools?: unknown[];
  /** Replace the chosen model id outright. Used by Perplexity (sonar-*) and
   *  Groq (groq/compound) when the grounded path requires a specific model. */
  modelOverride?: string;
  /** Append to the chosen model id. Used by OpenRouter to enable ':online' search. */
  modelSuffix?: string;
  /** Dispatch the OpenAI-compatible call through the Responses API instead of
   *  Chat Completions. Only set for `https://api.openai.com/v1` when the
   *  resolver picks the built-in `web_search` tool. The OpenAI client owns
   *  the actual tool wiring — this flag is the switch the facade reads. */
  useResponsesApi?: boolean;
  /** Pre-fetch search results from a separate provider and inject them into
   *  the prompt. Only set for DeepSeek today (`'perplexity'` — reuses the
   *  wearer's Perplexity API key). The facade fans out the search call
   *  before the chat call. */
  prefetchSearch?: 'perplexity';
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
    case 'https://api.openai.com/v1': {
      // OpenAI's Chat Completions has no built-in web search. The Responses
      // API does — switch to it for grounded calls when the chosen model
      // accepts the tool. A wearer who pinned a non-GPT-5/4.1 model (e.g. an
      // o1 reasoning model) stays on Chat Completions and the call falls back
      // to `groundless`, surfacing the `°` badge so the wearer can pick a
      // different model.
      const model = currentModel ?? '';
      if (OPENAI_RESPONSES_WEB_SEARCH_PATTERN.test(model)) {
        return { useResponsesApi: true, mode: 'grounded' };
      }
      return { mode: 'groundless' };
    }
    case 'https://api.groq.com/openai/v1': {
      // Groq's `groq/compound` family runs Tavily-backed web search inline
      // and returns `executed_tools[].search_results[]` on the response.
      // Always override the model when grounding is requested — the wearer's
      // pinned llama-3.x choice isn't grounding-capable on its own.
      const model = currentModel ?? '';
      if (model.startsWith('groq/compound')) {
        return { mode: 'grounded' };
      }
      return {
        modelOverride: GROQ_COMPOUND_MODEL,
        mode: 'grounded',
      };
    }
    case 'https://api.deepseek.com/v1': {
      // DeepSeek's chat API has no native web search. Pre-fetch via the
      // Perplexity Search API (the wearer's existing Perplexity key,
      // borrowed the same way `sttHost` is borrowed for chat-only providers).
      // The facade checks for the key — if absent, mode drops to `groundless`
      // there rather than throwing here.
      return { prefetchSearch: 'perplexity', mode: 'grounded' };
    }
    default:
      // Unknown host. Mark groundless so the HUD flags it; resolver stays
      // forward-compatible if a new OpenAI-compatible host is registered.
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
