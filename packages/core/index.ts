// Types
export * from './src/types';

// LLM
export * from './src/llm/index';
export * from './src/llm/streamingJsonParser';
export { resolveProviderGrounding, applyModelGrounding } from './src/llm/tools';
export type { ProviderGroundingResult } from './src/llm/tools';
export { fetchOpenAiModels } from './src/llm/openai';

// Personas — LensGrounding is already exported (wider) from types; suppress the narrower duplicate
export {
  personas,
  getPersona,
  getPickerPersonas,
  getSpecializedPersonas,
} from './src/personas/index';
export type {
  PersonaId,
  StreamHeadingConfig,
  Persona,
} from './src/personas/index';

// Persona utilities
export { formatRelativeTime } from './src/personas/_utils';

// Auto persona
export {
  AUTO_LENS_CANDIDATES,
  buildAutoClassifierSchema,
  buildAutoPrompt,
  parseAutoClassifierResponse,
} from './src/personas/auto';
export type { AutoLensCandidate, AutoClassification } from './src/personas/auto';

// Session summary persona
export {
  SESSION_SUMMARY_ID,
  SESSION_SUMMARY_NAME,
  SESSION_SUMMARY_SCHEMA,
  SESSION_SUMMARY_LIMITS,
  buildSessionSummaryPrompt,
  parseSessionSummaryResponse,
} from './src/personas/sessionSummary';
export type { PriorSummarySegment, SessionSummaryOptions } from './src/personas/sessionSummary';

// Meeting prep persona
export {
  MEETING_PREP_ID,
  buildMeetingPrepPrompt,
  buildMeetingPrepSchema,
  parseMeetingPrepResponse,
} from './src/personas/meetingPrep';

// Translation persona
export {
  SAY_MORE_SCHEMA,
  WEARER_SPEAK_SCHEMA,
  buildSayMorePrompt,
  buildWearerSpeakPrompt,
  parseSayMoreResponse,
  parseWearerSpeakResponse,
} from './src/personas/translation';
export type { SayMoreArgs, WearerSpeakArgs, TranslationSourceConfig, TranslationMode } from './src/personas/translation';

// Game persona
export {
  GAME_RESPONSE_SCHEMA,
  buildGamePrompt,
  parseGameResponse,
  shuffleQuizOptions,
  buildGameResult,
} from './src/personas/game';
export type { ParsedGameResponse } from './src/personas/game';

// Runtime
export * from './src/runtime/audioBuffer';
export * from './src/runtime/autoMode';
export * from './src/runtime/relevanceGate';
export * from './src/runtime/transcript';
export * from './src/runtime/transcriptSource';
export * from './src/runtime/recallContext';
export * from './src/runtime/gameHistory';
export * from './src/runtime/history';
export * from './src/runtime/ttsText';
// VAD — re-export everything except VoiceBufferAnalysis (already exported from audioBuffer above)
export {
  warmupVAD,
  analyzeBufferForVoice,
  extractSpeechSegments,
  resetVADAvailability,
  __resetVADAvailabilityForTests,
} from './src/runtime/vad/index';
export { getSileroVAD, SileroVADSession } from './src/runtime/vad/silero';

// Settings shim (for configuring the settings getter at bootstrap)
export * from './src/state/store';
