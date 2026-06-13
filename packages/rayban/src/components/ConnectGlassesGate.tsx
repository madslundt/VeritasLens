import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { ReactNode } from 'react';

interface Props {
  connected: boolean;
  children: ReactNode;
}

export function ConnectGlassesGate({ connected, children }: Props) {
  if (!connected) {
    return (
      <View style={styles.container}>
        <Text style={styles.icon}>🕶️</Text>
        <Text style={styles.title}>Connect your glasses</Text>
        <Text style={styles.body}>
          Pair your Ray-Ban Meta glasses via Bluetooth and enable the microphone in the Meta View app.
        </Text>
      </View>
    );
  }
  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  body: {
    color: '#888',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
