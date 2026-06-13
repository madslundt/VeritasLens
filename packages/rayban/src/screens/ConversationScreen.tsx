import React from 'react';
import { View, Text, FlatList, StyleSheet, ListRenderItem } from 'react-native';
import type { HistoryEntry } from '@veritaslens/core';
import { useStore } from '../state/store';
import { ResultCard } from '../components/ResultCard';

export function ConversationScreen() {
  const sessionHistory = useStore((s) => s.sessionHistory);

  const renderItem: ListRenderItem<HistoryEntry> = ({ item }) => (
    <ResultCard result={item.result} />
  );

  return (
    <View style={styles.container}>
      {sessionHistory.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No results yet</Text>
          <Text style={styles.emptyBody}>
            Tap the button on the Home tab to analyse what you hear.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessionHistory}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  list: {
    paddingVertical: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  emptyBody: {
    color: '#888',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
