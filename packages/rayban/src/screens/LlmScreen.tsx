import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Modal, Switch,
} from 'react-native';
import {
  runSelfTest, settings, OPENAI_BASE_URLS, OPENAI_INLINE_AUDIO_HOSTS,
  STT_HOSTS, openaiHostLabel, normalizeOpenAiBaseUrl,
  isCustomOpenAiBaseUrl, isOpenAiChatOnlyHost, isCustomSttHost, defaultSttModel,
  fetchTranscriptionModels, STT_MODELS_BY_HOST,
  runTavilySelfTest,
} from '@veritaslens/core';
import type { LlmProvider, SttHost } from '@veritaslens/core';
import { useStore } from '../state/store';
import { patchFullSettings } from '../runtime/bootstrap';
import { setLocalStorage } from '../runtime/bridge-rn';
import { parseFallbackUrls } from '../runtime/endpointSettings';

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  gemini: 'Gemini', 'openai-compatible': 'OpenAI-compatible', claude: 'Claude',
};
const PROVIDERS: LlmProvider[] = ['gemini', 'openai-compatible', 'claude'];

export function LlmScreen() {
  const storeSettings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [provider, setProvider] = useState(storeSettings.provider);
  const [baseUrl, setBaseUrl] = useState(storeSettings.openaiBaseUrl);
  const [model, setModel] = useState(storeSettings.geminiModel);
  const [apiKey, setApiKey] = useState('');
  const [fallbackUrls, setFallbackUrls] = useState('');
  const [sttHost, setSttHost] = useState<SttHost>(storeSettings.sttHost);
  const [sttModel, setSttModel] = useState(storeSettings.sttModel);
  const [sttKey, setSttKey] = useState('');
  const [sttFallbackUrls, setSttFallbackUrls] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [sttModelsLoading, setSttModelsLoading] = useState(false);
  const [sttModelsMessage, setSttModelsMessage] = useState<string | null>(null);
  const [sttModelPickerOpen, setSttModelPickerOpen] = useState(false);
  const sttModelsController = useRef<AbortController | null>(null);
  const [tavilyEnabled, setTavilyEnabled] = useState(storeSettings.tavilyEnabled ?? false);
  const [tavilyKey, setTavilyKey] = useState('');
  const [tavilyTesting, setTavilyTesting] = useState(false);
  const [tavilyMessage, setTavilyMessage] = useState<string | null>(null);
  const tavilyController = useRef<AbortController | null>(null);
  useEffect(() => {
    setTavilyMessage(null);
    setTavilyTesting(false);
    return () => { tavilyController.current?.abort(); tavilyController.current = null; };
  }, [tavilyEnabled, tavilyKey]);

  useEffect(() => {
    setSttModels([]);
    setSttModelsLoading(false);
    setSttModelsMessage(null);
    setSttModelPickerOpen(false);
    return () => {
      sttModelsController.current?.abort();
      sttModelsController.current = null;
    };
  }, [sttHost, sttKey, sttFallbackUrls, provider, baseUrl, apiKey]);

  // Hydration can finish after the screen's first render.
  useEffect(() => {
    const s = settings();
    setTavilyEnabled(storeSettings.tavilyEnabled ?? false);
    setTavilyKey(s.tavilyApiKey ?? '');
    setProvider(storeSettings.provider);
    setBaseUrl(storeSettings.openaiBaseUrl);
    setModel(storeSettings.provider === 'gemini' ? storeSettings.geminiModel
      : storeSettings.provider === 'claude' ? storeSettings.claudeModel : storeSettings.openaiModel);
    setApiKey(storeSettings.provider === 'gemini' ? s.geminiApiKey
      : storeSettings.provider === 'claude' ? s.claudeApiKey : s.openaiApiKeys[storeSettings.openaiBaseUrl] ?? '');
    setSttHost(storeSettings.sttHost);
    setSttModel(storeSettings.sttModel);
    setSttKey(s.openaiApiKeys[storeSettings.sttHost] ?? '');
    setFallbackUrls((storeSettings.openaiFallbackUrls?.[storeSettings.openaiBaseUrl] ?? []).join('\n'));
    setSttFallbackUrls((storeSettings.sttFallbackUrls?.[storeSettings.sttHost] ?? []).join('\n'));
  }, [storeSettings]);

  function chooseProvider(next: LlmProvider) {
    const s = settings();
    setProvider(next);
    setModel(next === 'gemini' ? storeSettings.geminiModel
      : next === 'claude' ? storeSettings.claudeModel : storeSettings.openaiModel);
    setApiKey(next === 'gemini' ? s.geminiApiKey
      : next === 'claude' ? s.claudeApiKey : s.openaiApiKeys[baseUrl] ?? '');
    setMessage(null);
  }

  function chooseHost(url: string) {
    setBaseUrl(url);
    setModel(url === storeSettings.openaiBaseUrl ? storeSettings.openaiModel : '');
    setApiKey(settings().openaiApiKeys[url] ?? '');
    setFallbackUrls((storeSettings.openaiFallbackUrls?.[url] ?? []).join('\n'));
    setMessage(null);
  }

  function chooseSttHost(host: string) {
    setSttHost(host);
    setSttModel(host === storeSettings.sttHost ? storeSettings.sttModel : defaultSttModel(host));
    setSttKey(settings().openaiApiKeys[host] ?? '');
    setSttFallbackUrls((storeSettings.sttFallbackUrls?.[host] ?? []).join('\n'));
    setMessage(null);
  }

  const endpointUrl = baseUrl.trim().replace(/\/+$/, '');
  const optionalSidecar = provider === 'gemini'
    || (provider === 'openai-compatible' && OPENAI_INLINE_AUDIO_HOSTS.has(endpointUrl));
  const needsStt = optionalSidecar || provider === 'claude'
    || (provider === 'openai-compatible' && isOpenAiChatOnlyHost(endpointUrl));
  const speechConfigured = isCustomSttHost(sttHost.trim().replace(/\/+$/, ''))
    ? Boolean(sttHost.trim() && sttModel.trim()) : Boolean(sttKey.trim());
  const useSpeechSettings = needsStt && (!optionalSidecar || speechConfigured);
  const busy = testing || saving || tavilyTesting;
  const availableSttModels = isCustomSttHost(sttHost) ? sttModels : STT_MODELS_BY_HOST[sttHost] ?? [];

  async function loadSttModels() {
    if (sttModelsLoading) return;
    const controller = new AbortController();
    sttModelsController.current?.abort();
    sttModelsController.current = controller;
    setSttModelsLoading(true);
    setSttModelsMessage(null);
    try {
      const speechUrl = normalizeOpenAiBaseUrl(sttHost);
      const sharesKey = provider === 'openai-compatible' && endpointUrl === speechUrl;
      const models = await fetchTranscriptionModels(
        sttKey.trim() || (sharesKey ? apiKey.trim() : ''), speechUrl, controller.signal,
        parseFallbackUrls(sttFallbackUrls, speechUrl),
      );
      if (controller.signal.aborted || sttModelsController.current !== controller) return;
      setSttModels(models);
      if (models.length > 0) setSttModelPickerOpen(true);
      else setSttModelsMessage('This server does not list models. Enter the model ID manually.');
    } catch (error) {
      if (!controller.signal.aborted && sttModelsController.current === controller) {
        setSttModelsMessage(`${error instanceof Error ? error.message : String(error)} Manual model entry is still available.`);
      }
    } finally {
      if (sttModelsController.current === controller) setSttModelsLoading(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setMessage(null);
    try {
      const url = provider === 'openai-compatible' ? normalizeOpenAiBaseUrl(baseUrl) : baseUrl;
      if (!model.trim()) throw new Error('Enter a model ID.');
      const probeSpeech = useSpeechSettings;
      const speechUrl = probeSpeech ? normalizeOpenAiBaseUrl(sttHost) : sttHost;
      if (probeSpeech && !sttModel.trim()) throw new Error('Enter a transcription model ID.');
      const sharesKey = provider === 'openai-compatible' && url === speechUrl;
      if (sharesKey && sttKey.trim() && sttKey.trim() !== apiKey.trim()) {
        throw new Error('Chat and transcription on the same base URL must use the same API key.');
      }
      const { latencyMs } = await runSelfTest(apiKey.trim(), model.trim(), {
        provider, baseUrl: url, lightweight: true,
        fallbackUrls: provider === 'openai-compatible' ? parseFallbackUrls(fallbackUrls, url) : [],
        ...(probeSpeech ? {
          sttHost: speechUrl, sttModel: sttModel.trim(),
          sttApiKey: sharesKey ? apiKey.trim() : sttKey.trim(),
          sttFallbackUrls: parseFallbackUrls(sttFallbackUrls, speechUrl),
        } : {}),
      });
      setMessage(`OK — ${latencyMs}ms`);
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setTesting(false); }
  }

  async function testTavily() {
    const controller = new AbortController();
    tavilyController.current = controller;
    setTavilyTesting(true);
    setTavilyMessage(null);
    try {
      const result = await runTavilySelfTest(tavilyKey.trim(), controller.signal);
      if (!controller.signal.aborted && tavilyController.current === controller) {
        setTavilyMessage(`Connected — ${result.resultCount} results, ${result.latencyMs}ms`);
      }
    } catch (error) {
      if (!controller.signal.aborted && tavilyController.current === controller) {
        setTavilyMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (tavilyController.current === controller) setTavilyTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      if (!model.trim()) throw new Error('Enter a model ID.');
      if (tavilyEnabled && !tavilyKey.trim()) throw new Error('Add a Tavily API key or turn off Tavily search.');
      const s = settings();
      const writes: Array<[string, string]> = [['veritaslens.provider', provider],
        ['veritaslens.tavilyEnabled', String(tavilyEnabled)], ['veritaslens.tavilyApiKey', tavilyKey.trim()]];
      const next = { ...storeSettings, provider, tavilyEnabled };
      const secrets = { ...s.openaiApiKeys };
      if (provider === 'gemini') {
        next.geminiModel = model.trim();
        writes.push(['veritaslens.geminiApiKey', apiKey.trim()], ['veritaslens.geminiModel', model.trim()]);
      } else if (provider === 'claude') {
        next.claudeModel = model.trim();
        writes.push(['veritaslens.claudeApiKey', apiKey.trim()], ['veritaslens.claudeModel', model.trim()]);
      } else {
        const url = normalizeOpenAiBaseUrl(baseUrl);
        next.openaiBaseUrl = url;
        next.openaiModel = model.trim();
        secrets[url] = apiKey.trim();
        next.openaiFallbackUrls = { ...next.openaiFallbackUrls, [url]: parseFallbackUrls(fallbackUrls, url) };
        writes.push(['veritaslens.openaiBaseUrl', url], ['veritaslens.openaiModel', model.trim()],
          [`veritaslens.openaiKey.${url}`, apiKey.trim()],
          ['veritaslens.openaiFallbackUrls', JSON.stringify(next.openaiFallbackUrls)]);
      }
      if (useSpeechSettings) {
        if (!sttModel.trim()) throw new Error('Enter a transcription model ID.');
        const speechUrl = normalizeOpenAiBaseUrl(sttHost);
        const sharesKey = provider === 'openai-compatible' && next.openaiBaseUrl === speechUrl;
        if (sharesKey && sttKey.trim() && sttKey.trim() !== apiKey.trim()) {
          throw new Error('Chat and transcription on the same base URL must use the same API key.');
        }
        const speechKey = sharesKey ? apiKey.trim() : sttKey.trim();
        next.sttHost = speechUrl;
        next.sttModel = sttModel.trim();
        next.sttFallbackUrls = { ...next.sttFallbackUrls, [speechUrl]: parseFallbackUrls(sttFallbackUrls, speechUrl) };
        secrets[speechUrl] = speechKey;
        writes.push(['veritaslens.sttHost', speechUrl], ['veritaslens.sttModel', sttModel.trim()],
          [`veritaslens.openaiKey.${speechUrl}`, speechKey],
          ['veritaslens.sttFallbackUrls', JSON.stringify(next.sttFallbackUrls)]);
      }
      const customUrls = Object.keys(secrets).filter(isCustomOpenAiBaseUrl);
      writes.push(['veritaslens.openaiCustomUrls', JSON.stringify(customUrls)]);
      const saved = await Promise.all(writes.map(([key, value]) => setLocalStorage(key, value)));
      if (saved.some((ok) => !ok)) throw new Error('Could not save all settings. Please try again.');
      updateSettings(next);
      patchFullSettings({ openaiApiKeys: secrets,
        tavilyEnabled, tavilyApiKey: tavilyKey.trim(),
        ...(provider === 'gemini' ? { geminiApiKey: apiKey.trim() } : {}),
        ...(provider === 'claude' ? { claudeApiKey: apiKey.trim() } : {}),
      });
      setMessage('Saved');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setSaving(false); }
  }

  function input(label: string, value: string, onChange: (text: string) => void, secret = false, placeholder?: string, multiline = false) {
    return <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={[styles.input, multiline && styles.multilineInput]} value={value}
        onChangeText={(text) => { onChange(text); setMessage(null); }} editable={!busy}
        secureTextEntry={secret} autoCapitalize="none" autoCorrect={false}
        multiline={multiline} textAlignVertical={multiline ? 'top' : 'center'}
        placeholder={placeholder} placeholderTextColor="#888" />
    </View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Provider</Text>
      <View style={styles.options}>
        {PROVIDERS.map((p) => <TouchableOpacity key={p} accessibilityRole="button"
          accessibilityState={{ selected: provider === p, disabled: busy }} disabled={busy}
          style={[styles.option, provider === p && styles.selected]} onPress={() => chooseProvider(p)}>
          <Text style={styles.optionText}>{PROVIDER_LABELS[p]}</Text>
        </TouchableOpacity>)}
      </View>
      {provider === 'openai-compatible' ? <>
        <Text style={styles.label}>Endpoint</Text>
        <View style={styles.options}>
          {[...OPENAI_BASE_URLS, ...Object.keys(settings().openaiApiKeys).filter(isCustomOpenAiBaseUrl)]
            .map((url) => <TouchableOpacity key={url} accessibilityRole="button" disabled={busy}
              accessibilityState={{ selected: baseUrl === url }} style={[styles.option, baseUrl === url && styles.selected]}
              onPress={() => chooseHost(url)}><Text style={styles.optionText}>{openaiHostLabel(url)}</Text></TouchableOpacity>)}
        </View>
        {input('Base URL', baseUrl, (text) => {
          setBaseUrl(text);
          const normalized = text.trim().replace(/\/+$/, '');
          setApiKey(settings().openaiApiKeys[normalized] ?? '');
          setFallbackUrls((storeSettings.openaiFallbackUrls?.[normalized] ?? []).join('\n'));
        }, false, 'https://your-server.example/v1')}
        <Text style={styles.hint}>Enter the API base URL, including /v1 if your server uses it. Custom endpoints use the transcription provider below.</Text>
        {input('Chat fallback URLs (one per line, in order)', fallbackUrls, setFallbackUrls, false,
          'https://alternate-address.example/v1', true)}
        <Text style={styles.hint}>Alternate addresses of the same server share this endpoint’s API key and model. They are tried in order after a connection failure.</Text>
      </> : null}
      {input('Model ID', model, setModel, false, provider === 'openai-compatible' ? 'Model ID from your server' : undefined)}
      {input('API key', apiKey, setApiKey, true, provider === 'openai-compatible' && isCustomOpenAiBaseUrl(baseUrl) ? 'Optional for servers without authentication' : 'Paste API key')}
      {needsStt ? <>
        <Text style={styles.label}>Transcription provider</Text>
        <View style={styles.options}>
          {STT_HOSTS.map((host) => <TouchableOpacity key={host} accessibilityRole="button" disabled={busy}
            accessibilityState={{ selected: sttHost === host }} style={[styles.option, sttHost === host && styles.selected]}
            onPress={() => chooseSttHost(host)}>
            <Text style={styles.optionText}>{openaiHostLabel(host)}</Text>
          </TouchableOpacity>)}
          <TouchableOpacity accessibilityRole="button" disabled={busy}
            accessibilityState={{ selected: isCustomSttHost(sttHost) }}
            style={[styles.option, isCustomSttHost(sttHost) && styles.selected]}
            onPress={() => chooseSttHost('')}><Text style={styles.optionText}>Custom Whisper server</Text></TouchableOpacity>
        </View>
        {input('Transcription base URL', sttHost, (text) => {
          setSttHost(text);
          const normalized = text.trim().replace(/\/+$/, '');
          setSttKey(settings().openaiApiKeys[normalized] ?? '');
          setSttFallbackUrls((storeSettings.sttFallbackUrls?.[normalized] ?? []).join('\n'));
        }, false, 'https://whisper.example/v1')}
        <Text style={styles.hint}>Use an OpenAI-compatible server with /audio/transcriptions. {optionalSidecar ? 'Audio still goes directly to the analysis provider; this optional server provides the transcript sidecar.' : 'Audio is transcribed here before the transcript is sent for analysis.'}</Text>
        {input('Transcription model', sttModel, setSttModel)}
        {isCustomSttHost(sttHost) ? <TouchableOpacity accessibilityRole="button"
          style={[styles.button, (busy || sttModelsLoading) && styles.disabled]} disabled={busy || sttModelsLoading}
          onPress={() => void loadSttModels()}>
          {sttModelsLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Load Whisper models</Text>}
        </TouchableOpacity> : null}
        {availableSttModels.length > 0 ? <TouchableOpacity accessibilityRole="button"
          accessibilityLabel="Select transcription model" accessibilityState={{ expanded: sttModelPickerOpen }}
          style={styles.button} disabled={busy} onPress={() => setSttModelPickerOpen(true)}>
          <Text style={styles.buttonText}>Select transcription model ▾</Text>
        </TouchableOpacity> : null}
        {sttModelsMessage ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{sttModelsMessage}</Text> : null}
        <Modal visible={sttModelPickerOpen} transparent animationType="slide"
          onRequestClose={() => setSttModelPickerOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modelPicker} accessibilityViewIsModal>
              <Text style={styles.label}>Transcription model</Text>
              <ScrollView>
                {availableSttModels.map((id) => <TouchableOpacity key={id} accessibilityRole="button"
                  accessibilityState={{ selected: id === sttModel }} style={[styles.option, id === sttModel && styles.selected]}
                  onPress={() => { setSttModel(id); setSttModelPickerOpen(false); }}>
                  <Text style={styles.optionText}>{id}</Text>
                </TouchableOpacity>)}
              </ScrollView>
              <TouchableOpacity accessibilityRole="button" style={styles.button} onPress={() => setSttModelPickerOpen(false)}>
                <Text style={styles.buttonText}>Close model list</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
        {input('Transcription API key', sttKey, setSttKey, true,
          isCustomSttHost(sttHost) ? 'Optional for servers without authentication' : 'Paste API key')}
        {input('Transcription fallback URLs (one per line, in order)', sttFallbackUrls, setSttFallbackUrls, false,
          'https://alternate-whisper.example/v1', true)}
        <Text style={styles.hint}>Alternate addresses of the same transcription server share its API key and model. They are tried in the order shown.</Text>
      </> : null}
      <Text style={styles.label}>Optional Tavily web search</Text>
      <View style={styles.options}>
        <Switch accessibilityLabel="Use Tavily web search" value={tavilyEnabled} disabled={busy} onValueChange={setTavilyEnabled} />
        <Text style={styles.hint}>Use Tavily when the provider has no web search</Text>
      </View>
      <Text style={styles.hint}>Off by default. Search-enabled lenses send a short text query from captured speech to Tavily. Native search takes priority; failed searches still return an answer marked as ungrounded.</Text>
      {input('Tavily API key', tavilyKey, setTavilyKey, true, 'tvly-…')}
      <Text style={styles.hint}>Turning Tavily off keeps your saved API key.</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.button, (busy || !tavilyKey.trim()) && styles.disabled]}
        disabled={busy || !tavilyKey.trim()} onPress={() => void testTavily()}>
        {tavilyTesting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Test Tavily search</Text>}
      </TouchableOpacity>
      {tavilyMessage ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{tavilyMessage}</Text> : null}
      <TouchableOpacity accessibilityRole="button" style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => void runTest()}>
        {testing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Test {PROVIDER_LABELS[provider]}</Text>}
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" style={[styles.button, styles.selected, busy && styles.disabled]} disabled={busy} onPress={() => void save()}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save settings</Text>}
      </TouchableOpacity>
      {message ? <Text accessibilityLiveRegion="polite" style={[styles.message, message.startsWith('Error') && styles.error]}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  field: { gap: 6 },
  label: { color: '#bbb', fontSize: 14, fontWeight: '600' },
  hint: { color: '#999', fontSize: 13, lineHeight: 20 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { backgroundColor: '#1a1a1a', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#333', minHeight: 44 },
  selected: { backgroundColor: '#1a2d1a', borderColor: '#4caf50' },
  optionText: { color: '#ddd', fontSize: 14 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, padding: 12, fontSize: 16, borderWidth: 1, borderColor: '#333', minHeight: 44 },
  multilineInput: { minHeight: 96 },
  button: { backgroundColor: '#222', borderRadius: 10, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#444', minHeight: 48 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  message: { fontSize: 14, textAlign: 'center', color: '#4caf50' },
  error: { color: '#f44336' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0009' },
  modelPicker: { maxHeight: '70%', backgroundColor: '#111', padding: 20, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
});
