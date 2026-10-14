import type { LensResult } from '@veritaslens/core';

export interface ResultSection {
  title: string;
  body?: string;
  quote?: string;
  badge?: string;
}

const lines = (...values: Array<string | undefined>) => values.filter(Boolean).join('\n\n');

/** Keep presentation exhaustive as new lenses are added to the shared result union. */
export function resultSections(result: LensResult): ResultSection[] {
  switch (result.type) {
    case 'fact-check': return result.claims.map((c) => ({ title: c.claim, body: lines(c.reason, c.correction), quote: c.quote, badge: c.verdict }));
    case 'trivia': return result.claims.map((c) => ({ title: c.question, body: lines(c.answer, c.description, c.alt), quote: c.quote }));
    case 'logical-fallacy': return result.claims.map((c) => ({ title: c.fallacy, body: lines(c.explanation, c.callOut), quote: c.quote }));
    case 'bias': return result.claims.map((c) => ({ title: c.direction || c.verdict, body: lines(c.reason, c.counterFrame), quote: c.quote, badge: c.verdict }));
    case 'eli5': return result.claims.map((c) => ({ title: c.oneLine || c.explanation || '', body: c.expanded, quote: c.quote }));
    case 'devils-advocate': return result.claims.map((c) => ({ title: c.counterpoint, body: lines(c.rationale, c.pivot), quote: c.quote }));
    case 'key-questions': return result.claims.map((c) => ({ title: c.question, body: c.context, badge: c.priority }));
    case 'companion': return result.claims.map((c) => ({ title: c.headline, body: c.detail, quote: c.quote, badge: c.kind }));
    case 'meeting-prep': return result.claims.map((c) => ({ title: c.text, body: lines(c.detail, c.source ? `From: ${c.source}${c.sourceMeta ? ` · ${c.sourceMeta}` : ''}` : ''), badge: c.kind }));
    case 'session-summary': return [{ title: result.title, body: lines(result.summary, ...result.keyPoints.map((point) => `• ${point}`)), quote: result.quote }];
    case 'translation': return [
      { title: result.translatedText, body: lines(result.sourceText, result.sourceTextRomanized), badge: result.sourceLanguage },
      ...result.replyStarters.map((s) => ({ title: s.translated, body: lines(s.source, s.sourceRomanized), badge: 'Reply' })),
    ];
    case 'game': return [
      { title: result.preset.topic || 'Random topic', body: result.preset.format === 'riddle' ? `${result.questions.length} riddles` : `Score: ${result.score} / ${result.questions.length}` },
      ...result.questions.map((q, i) => ({ title: q.text, body: lines(result.answers[i] == null ? 'Skipped' : `Your answer: ${q.options[result.answers[i]!] ?? ''}`, q.reveal) })),
    ];
  }
}
