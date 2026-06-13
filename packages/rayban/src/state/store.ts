import { create } from 'zustand';
import type { HistoryEntry, LensResult, SttHost } from '@veritaslens/core';

export type AppPhase = 'booting' | 'idle' | 'listening' | 'thinking' | 'displaying' | 'error';

export type LlmProvider = 'gemini' | 'openai-compatible' | 'claude';

export interface RaybanSettings {
  activeLensId: string;
  cameraEnabled: boolean;
  ttsEnabled: boolean;
  ttsRate: number;
  bufferDurationSec: 30 | 120 | 300;
  provider: LlmProvider;
  geminiModel: string;
  claudeModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  sttHost: SttHost;
  sttModel: string;
}

export interface GlassesConnection {
  hfpConnected: boolean;
  cameraStreaming: boolean;
  cameraSdkAvailable: boolean;
}

export interface RaybanStore {
  // State
  appPhase: AppPhase;
  settings: RaybanSettings;
  sessionHistory: HistoryEntry[];
  lastResult: HistoryEntry | null;
  streamingResult: LensResult | null;
  glassesConnection: GlassesConnection;

  // Actions
  setAppPhase: (phase: AppPhase) => void;
  updateSettings: (partial: Partial<RaybanSettings>) => void;
  appendHistoryEntry: (entry: HistoryEntry) => void;
  setSessionHistory: (entries: HistoryEntry[]) => void;
  setStreamingResult: (result: LensResult | null) => void;
  setGlassesConnection: (partial: Partial<GlassesConnection>) => void;
  reset: () => void;
}

const DEFAULT_SETTINGS: RaybanSettings = {
  activeLensId: 'fact-checker',
  cameraEnabled: true,
  ttsEnabled: true,
  ttsRate: 1.0,
  bufferDurationSec: 30,
  provider: 'gemini',
  geminiModel: 'gemini-2.5-flash',
  claudeModel: 'claude-sonnet-4-6',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  sttHost: 'https://api.groq.com/openai/v1' as SttHost,
  sttModel: 'whisper-large-v3',
};

export const useStore = create<RaybanStore>((set) => ({
  appPhase: 'idle',
  settings: DEFAULT_SETTINGS,
  sessionHistory: [],
  lastResult: null,
  streamingResult: null,
  glassesConnection: { hfpConnected: false, cameraStreaming: false, cameraSdkAvailable: false },

  setAppPhase: (phase) => set({ appPhase: phase }),
  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  appendHistoryEntry: (entry) =>
    set((s) => ({ sessionHistory: [entry, ...s.sessionHistory], lastResult: entry })),
  setSessionHistory: (entries) =>
    set({ sessionHistory: entries, lastResult: entries[0] ?? null }),
  setStreamingResult: (result) => set({ streamingResult: result }),
  setGlassesConnection: (partial) =>
    set((s) => ({ glassesConnection: { ...s.glassesConnection, ...partial } })),
  reset: () => set({
    appPhase: 'idle',
    settings: DEFAULT_SETTINGS,
    sessionHistory: [],
    lastResult: null,
    streamingResult: null,
    glassesConnection: { hfpConnected: false, cameraStreaming: false, cameraSdkAvailable: false },
  }),
}));
