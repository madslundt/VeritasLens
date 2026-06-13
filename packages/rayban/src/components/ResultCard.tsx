import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { LensResult } from '@veritaslens/core';

interface Props {
  result: LensResult | null;
}

/** Extract a human-readable headline from any LensResult variant. */
function headlineFromResult(result: LensResult): string | null {
  const r = result as Record<string, unknown>;
  // Common string fields emitted by persona parse() functions.
  if (typeof r['question'] === 'string' && r['question']) return r['question'] as string;
  if (typeof r['translatedText'] === 'string' && r['translatedText']) return r['translatedText'] as string;
  if (typeof r['answer'] === 'string' && r['answer']) return r['answer'] as string;
  if (typeof r['topic'] === 'string' && r['topic']) return r['topic'] as string;
  return null;
}

/** Extract a supporting quote / summary from any LensResult variant. */
function bodyFromResult(result: LensResult): string | null {
  const r = result as Record<string, unknown>;
  if (typeof r['quote'] === 'string' && r['quote']) return r['quote'] as string;
  if (typeof r['summary'] === 'string' && r['summary']) return r['summary'] as string;
  if (typeof r['explanation'] === 'string' && r['explanation']) return r['explanation'] as string;
  return null;
}

export function ResultCard({ result }: Props) {
  if (!result) return null;

  const headline = headlineFromResult(result);
  const body = bodyFromResult(result);
  const r = result as Record<string, unknown>;
  const badge = typeof r['badge'] === 'string' ? r['badge'] as string : null;
  const lensType = result.type ?? '';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.lensName}>{lensType}</Text>
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </View>
      {headline ? <Text style={styles.question}>{headline}</Text> : null}
      {body ? <Text style={styles.quote}>{body}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginVertical: 6,
    marginHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lensName: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badge: {
    color: '#4caf50',
    fontSize: 12,
    fontWeight: '700',
  },
  question: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  quote: {
    color: '#bbb',
    fontSize: 14,
    lineHeight: 20,
    fontStyle: 'italic',
    marginBottom: 8,
  },
});
