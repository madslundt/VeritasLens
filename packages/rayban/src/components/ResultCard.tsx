import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { LensResult } from '@veritaslens/core';
import { resultSections } from './resultPresentation';

interface Props {
  result: LensResult | null;
}

export function ResultCard({ result }: Props) {
  if (!result) return null;
  const sections = resultSections(result);
  return (
    <View style={styles.card}>
      <Text style={styles.lensName}>{result.type.replace(/-/g, ' ')}</Text>
      {sections.map((section, index) => (
        <View key={index} style={[styles.section, index > 0 && styles.followingSection]}>
          {section.badge ? <Text style={[styles.badge,
            (section.badge === 'FALSE' || section.badge === 'BIASED') && styles.badgeBad,
            section.badge === 'UNVERIFIED' && styles.badgeUnknown]}>{section.badge}</Text> : null}
          {section.title ? <Text style={styles.question}>{section.title}</Text> : null}
          {section.body ? <Text style={styles.body}>{section.body}</Text> : null}
          {section.quote ? <Text style={styles.quote}>“{section.quote}”</Text> : null}
        </View>
      ))}
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
  section: { marginTop: 8 },
  followingSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#444', paddingTop: 12 },
  body: { color: '#ddd', fontSize: 14, lineHeight: 21, marginBottom: 8 },
  badgeBad: { color: '#f44336' },
  badgeUnknown: { color: '#ff9800' },
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
