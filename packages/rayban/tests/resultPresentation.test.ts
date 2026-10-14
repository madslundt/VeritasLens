import { describe, expect, it } from 'vitest';
import { resultSections } from '../src/components/resultPresentation';

describe('result presentation', () => {
  it('renders every fact-check claim with the actual verdict and correction', () => {
    expect(resultSections({ type: 'fact-check', claims: [
      { claim: 'Mars has rings', quote: 'Mars has rings', verdict: 'FALSE', reason: 'Mars has no rings.', correction: 'Saturn has rings.' },
      { claim: 'Earth has a moon', quote: 'our moon', verdict: 'TRUE', reason: 'Earth has one moon.' },
    ] })).toEqual([
      { title: 'Mars has rings', quote: 'Mars has rings', badge: 'FALSE', body: 'Mars has no rings.\n\nSaturn has rings.' },
      { title: 'Earth has a moon', quote: 'our moon', badge: 'TRUE', body: 'Earth has one moon.' },
    ]);
  });

  it('uses modern ELI5 fields and supports legacy explanations', () => {
    expect(resultSections({ type: 'eli5', claims: [{ quote: 'entropy', oneLine: 'Disorder increases.', expanded: 'Think of a messy room.' }] })[0]).toMatchObject({ title: 'Disorder increases.', body: 'Think of a messy room.' });
    expect(resultSections({ type: 'eli5', claims: [{ quote: 'entropy', explanation: 'Things get messier.' }] })[0].title).toBe('Things get messier.');
  });

  it('shows translation source, romanization and reply starters', () => {
    const sections = resultSections({ type: 'translation', sourceLanguage: 'ja', sourceText: 'こんにちは', sourceTextRomanized: 'Konnichiwa', translatedText: 'Hello', replyStarters: [{ source: 'はい', sourceRomanized: 'Hai', translated: 'Yes' }] });
    expect(sections[0]).toMatchObject({ title: 'Hello', body: 'こんにちは\n\nKonnichiwa' });
    expect(sections[1]).toMatchObject({ title: 'Yes', body: 'はい\n\nHai' });
  });

  it('preserves multiple trivia answers instead of rendering an empty card', () => {
    const sections = resultSections({ type: 'trivia', claims: [{ quote: 'capital of France?', question: 'Capital of France?', answer: 'Paris', description: 'The capital city.' }, { quote: 'and Spain?', question: 'Capital of Spain?', answer: 'Madrid', description: 'The capital of Spain.' }] });
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.body)).toEqual(['Paris\n\nThe capital city.', 'Madrid\n\nThe capital of Spain.']);
  });
});
