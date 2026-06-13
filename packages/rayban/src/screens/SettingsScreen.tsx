import React from 'react';
import {
  View,
  Text,
  Switch,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useStore } from '../state/store';
import { patchFullSettings } from '../runtime/bootstrap';
import { setLocalStorage } from '../runtime/bridge-rn';

const KEY_TTS_ENABLED = 'veritaslens.ttsEnabled';
const KEY_CAMERA_ENABLED = 'veritaslens.cameraEnabled';

export function SettingsScreen() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  function toggleTts(value: boolean) {
    updateSettings({ ttsEnabled: value });
    patchFullSettings({});
    void setLocalStorage(KEY_TTS_ENABLED, String(value));
  }

  function toggleCamera(value: boolean) {
    updateSettings({ cameraEnabled: value });
    void setLocalStorage(KEY_CAMERA_ENABLED, String(value));
  }

  const bufferOptions: Array<30 | 120 | 300> = [30, 120, 300];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionHeader}>Audio</Text>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Text-to-speech</Text>
        <Switch
          value={settings.ttsEnabled}
          onValueChange={toggleTts}
          trackColor={{ true: '#4caf50', false: '#333' }}
          thumbColor="#fff"
        />
      </View>

      <Text style={styles.sectionHeader}>Camera</Text>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Include camera frame</Text>
        <Switch
          value={settings.cameraEnabled}
          onValueChange={toggleCamera}
          trackColor={{ true: '#4caf50', false: '#333' }}
          thumbColor="#fff"
        />
      </View>

      <Text style={styles.sectionHeader}>Buffer duration</Text>

      <View style={styles.segmentRow}>
        {bufferOptions.map((sec) => (
          <TouchableOpacity
            key={sec}
            style={[
              styles.segmentButton,
              settings.bufferDurationSec === sec && styles.segmentButtonActive,
            ]}
            onPress={() => {
              updateSettings({ bufferDurationSec: sec });
              void setLocalStorage('veritaslens.bufferDurationSec', String(sec));
            }}
          >
            <Text
              style={[
                styles.segmentLabel,
                settings.bufferDurationSec === sec && styles.segmentLabelActive,
              ]}
            >
              {sec}s
            </Text>
          </TouchableOpacity>
        ))}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  rowLabel: {
    color: '#fff',
    fontSize: 16,
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
    fontSize: 15,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: '#4caf50',
  },
});
