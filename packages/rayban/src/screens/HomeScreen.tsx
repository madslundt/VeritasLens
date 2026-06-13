import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useStore } from '../state/store';
import { StatusPill } from '../components/StatusPill';
import { ConnectGlassesGate } from '../components/ConnectGlassesGate';
import { ResultCard } from '../components/ResultCard';
import { triggerAnalysis, cancelAnalysis } from '../runtime/lifecycle';

export function HomeScreen() {
  const appPhase = useStore((s) => s.appPhase);
  const glassesConnection = useStore((s) => s.glassesConnection);
  const lastResult = useStore((s) => s.lastResult);
  const streamingResult = useStore((s) => s.streamingResult);

  const isThinking = appPhase === 'thinking';

  function handleTap() {
    if (isThinking) {
      cancelAnalysis();
    } else {
      void triggerAnalysis();
    }
  }

  return (
    <ConnectGlassesGate connected={glassesConnection.hfpConnected}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <StatusPill phase={appPhase} />

          <TouchableOpacity
            style={[styles.tapButton, isThinking && styles.tapButtonActive]}
            onPress={handleTap}
            activeOpacity={0.7}
          >
            {isThinking ? (
              <ActivityIndicator color="#fff" size="large" />
            ) : (
              <Text style={styles.tapLabel}>TAP</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.hint}>
            {isThinking ? 'Tap to cancel' : 'Tap to analyse'}
          </Text>

          {(isThinking && streamingResult) || lastResult ? (
            <View style={styles.resultSection}>
              <Text style={styles.sectionTitle}>
                {isThinking && streamingResult ? 'Streaming…' : 'Last result'}
              </Text>
              <ResultCard
                result={isThinking ? streamingResult : (lastResult?.result ?? null)}
              />
            </View>
          ) : null}
        </ScrollView>
      </View>
    </ConnectGlassesGate>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  scroll: {
    paddingTop: 32,
    paddingBottom: 40,
    alignItems: 'center',
  },
  tapButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#333',
  },
  tapButtonActive: {
    borderColor: '#ff9800',
    backgroundColor: '#1a1200',
  },
  tapLabel: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 4,
  },
  hint: {
    color: '#666',
    fontSize: 14,
    marginBottom: 24,
  },
  resultSection: {
    width: '100%',
    marginTop: 8,
  },
  sectionTitle: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: 16,
    marginBottom: 4,
  },
});
