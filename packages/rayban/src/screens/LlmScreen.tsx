import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { runSelfTest, settings } from '@veritaslens/core';
import { useStore } from '../state/store';
import { patchFullSettings } from '../runtime/bootstrap';
import { setLocalStorage } from '../runtime/bridge-rn';

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  'openai-compatible': 'OpenAI-compatible',
  claude: 'Claude',
};

export function LlmScreen() {
  const storeSettings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  const [draftGeminiKey, setDraftGeminiKey] = useState('');
  const [draftClaudeKey, setDraftClaudeKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const s = settings();
      const provider = storeSettings.provider;
      let apiKey = '';
      let model: string | undefined;
      if (provider === 'gemini') {
        apiKey = s.geminiApiKey;
        model = storeSettings.geminiModel;
      } else if (provider === 'claude') {
        apiKey = s.claudeApiKey;
        model = storeSettings.claudeModel;
      } else {
        apiKey = s.openaiApiKeys[storeSettings.openaiBaseUrl as keyof typeof s.openaiApiKeys] ?? '';
        model = storeSettings.openaiModel;
      }
      const { latencyMs } = await runSelfTest(apiKey, model, {
        provider,
        lightweight: true,
      });
      setTestResult(`OK — ${latencyMs}ms`);
    } catch (err: unknown) {
      setTestResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  }

  function saveGeminiKey() {
    patchFullSettings({ geminiApiKey: draftGeminiKey });
    void setLocalStorage('veritaslens.geminiApiKey', draftGeminiKey);
    setDraftGeminiKey('');
  }

  function saveClaudeKey() {
    patchFullSettings({ claudeApiKey: draftClaudeKey });
    void setLocalStorage('veritaslens.claudeApiKey', draftClaudeKey);
    setDraftClaudeKey('');
  }

  const providerOptions: Array<'gemini' | 'openai-compatible' | 'claude'> = [
    'gemini',
    'openai-compatible',
    'claude',
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionHeader}>Provider</Text>
      <View style={styles.segmentRow}>
        {providerOptions.map((p) => (
          <TouchableOpacity
            key={p}
            style={[
              styles.segmentButton,
              storeSettings.provider === p && styles.segmentButtonActive,
            ]}
            onPress={() => {
              updateSettings({ provider: p });
              void setLocalStorage('veritaslens.provider', p);
            }}
          >
            <Text
              style={[
                styles.segmentLabel,
                storeSettings.provider === p && styles.segmentLabelActive,
              ]}
            >
              {PROVIDER_LABELS[p]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionHeader}>Gemini API key</Text>
      <View style={styles.keyRow}>
        <TextInput
          style={styles.keyInput}
          placeholder="Paste key and save"
          placeholderTextColor="#555"
          value={draftGeminiKey}
          onChangeText={setDraftGeminiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.saveButton}
          onPress={saveGeminiKey}
          disabled={!draftGeminiKey}
        >
          <Text style={styles.saveLabel}>Save</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Claude API key</Text>
      <View style={styles.keyRow}>
        <TextInput
          style={styles.keyInput}
          placeholder="Paste key and save"
          placeholderTextColor="#555"
          value={draftClaudeKey}
          onChangeText={setDraftClaudeKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.saveButton}
          onPress={saveClaudeKey}
          disabled={!draftClaudeKey}
        >
          <Text style={styles.saveLabel}>Save</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Test connection</Text>
      <View style={styles.testRow}>
        <TouchableOpacity
          style={styles.testButton}
          onPress={() => void runTest()}
          disabled={testing}
        >
          {testing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.testLabel}>Test {PROVIDER_LABELS[storeSettings.provider]}</Text>
          )}
        </TouchableOpacity>
        {testResult ? (
          <Text
            style={[
              styles.testResult,
              testResult.startsWith('OK') ? styles.testResultOk : styles.testResultError,
            ]}
          >
            {testResult}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  content: {
    paddingBottom: 40,
  },
  sectionHeader: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 4,
    marginHorizontal: 16,
  },
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 4,
    gap: 8,
  },
  segmentButton: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  segmentButtonActive: {
    backgroundColor: '#1a2d1a',
    borderColor: '#4caf50',
  },
  segmentLabel: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: '#4caf50',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    gap: 8,
  },
  keyInput: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#333',
  },
  saveButton: {
    backgroundColor: '#333',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  testRow: {
    marginHorizontal: 16,
    gap: 12,
  },
  testButton: {
    backgroundColor: '#222',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  testLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  testResult: {
    fontSize: 14,
    textAlign: 'center',
  },
  testResultOk: {
    color: '#4caf50',
  },
  testResultError: {
    color: '#f44336',
  },
});
