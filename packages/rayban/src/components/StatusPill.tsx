import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { AppPhase } from '../state/store';

const PHASE_LABEL: Record<AppPhase, string> = {
  booting: 'Booting…',
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking…',
  displaying: 'Done',
  error: 'Error',
};

const PHASE_COLOR: Record<AppPhase, string> = {
  booting: '#555',
  idle: '#555',
  listening: '#2196f3',
  thinking: '#ff9800',
  displaying: '#4caf50',
  error: '#f44336',
};

interface Props {
  phase: AppPhase;
}

export function StatusPill({ phase }: Props) {
  return (
    <View style={[styles.pill, { backgroundColor: PHASE_COLOR[phase] }]}>
      <Text style={styles.label}>{PHASE_LABEL[phase]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    alignSelf: 'center',
  },
  label: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
