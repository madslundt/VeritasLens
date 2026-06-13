// tests/relevanceGate.test.ts
import { describe, it, expect } from 'vitest';
import { GATE_TAIL_SEGMENTS, shouldAnalyze } from '../src/runtime/relevanceGate';
import type { TranscriptSegment } from '../src/runtime/transcript';

let seq = 0;
function seg(text: string, speaker: 'wearer' | 'other' = 'other'): TranscriptSegment {
  seq += 1;
  return {
    id: `seg-${seq}`,
    speaker,
    text,
    startedAt: 1_700_000_000_000 + seq,
    endedAt: 1_700_000_000_500 + seq,
  };
}

describe('relevanceGate.shouldAnalyze — fallbacks', () => {
  it('empty segments → pass (preserves transcript-off behaviour)', () => {
    expect(shouldAnalyze([], 'fact-checker')).toBe(true);
    expect(shouldAnalyze([], 'auto')).toBe(true);
    expect(shouldAnalyze([], 'unknown-lens')).toBe(true);
  });

  it('unknown / uncovered lens id → pass (translation, meeting-prep, companion, future ids)', () => {
    const tail = [seg('the airline cancelled all flights to Reykjavik today')];
    expect(shouldAnalyze(tail, 'translation')).toBe(true);
    expect(shouldAnalyze(tail, 'meeting-prep')).toBe(true);
    expect(shouldAnalyze(tail, 'companion')).toBe(true);
    expect(shouldAnalyze(tail, 'session-summary')).toBe(true);
    expect(shouldAnalyze(tail, 'lens-from-the-future')).toBe(true);
  });

  it('non-Latin / mostly-non-ASCII tail → pass (prevents Danish/German false suppressions)', () => {
    // Danish — would otherwise fail every English regex.
    const danish = [seg('jeg tror vi skal tale om hvornår vi mødes på torsdag')];
    expect(shouldAnalyze(danish, 'fact-checker')).toBe(true);
    expect(shouldAnalyze(danish, 'auto')).toBe(true);
    // German.
    const german = [seg('wir sollten über die Größe der Wohnung sprechen')];
    expect(shouldAnalyze(german, 'fact-checker')).toBe(true);
    // Cyrillic.
    const russian = [seg('добрый день как у вас дела сегодня')];
    expect(shouldAnalyze(russian, 'fact-checker')).toBe(true);
  });
});

describe('relevanceGate.shouldAnalyze — auto lens (filler-only blocklist)', () => {
  it('all filler → suppress', () => {
    const fillerOnly = [
      seg('yeah'), seg('mm-hmm'), seg('okay'), seg('right'), seg('sure'),
    ];
    expect(shouldAnalyze(fillerOnly, 'auto')).toBe(false);
  });

  it('one substantive segment among filler → pass', () => {
    const mixed = [
      seg('yeah'), seg('mm-hmm'), seg('actually the new policy starts in March'), seg('right'), seg('sure'),
    ];
    expect(shouldAnalyze(mixed, 'auto')).toBe(true);
  });

  it('isolated punctuation around filler still counts as filler', () => {
    const punctuated = [seg('Yeah.'), seg('Okay!'), seg('right,'), seg('sure?'), seg('mm-hmm')];
    expect(shouldAnalyze(punctuated, 'auto')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — fact-checker', () => {
  it('declarative numeric claim → fire', () => {
    const tail = [seg('the Eiffel Tower is 330 metres tall')];
    expect(shouldAnalyze(tail, 'fact-checker')).toBe(true);
  });

  it('percentage / statistic → fire', () => {
    expect(shouldAnalyze([seg('about 60 percent of voters say yes')], 'fact-checker')).toBe(true);
  });

  it('superlative copular claim → fire', () => {
    expect(shouldAnalyze([seg('it was the largest in the world')], 'fact-checker')).toBe(true);
  });

  it('chitchat with no checkable content → suppress', () => {
    expect(
      shouldAnalyze([seg('I really like your shoes'), seg('they look comfortable')], 'fact-checker'),
    ).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — trivia', () => {
  it('wh-question fires', () => {
    expect(shouldAnalyze([seg('what year was that')], 'trivia')).toBe(true);
  });

  it('question mark fires even without wh-words', () => {
    expect(shouldAnalyze([seg('is that really true?')], 'trivia')).toBe(true);
  });

  it('no question → suppress', () => {
    expect(shouldAnalyze([seg('I went for a walk earlier')], 'trivia')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — key-questions', () => {
  it('planning / decision language fires', () => {
    expect(shouldAnalyze([seg("let's pick the venue this weekend")], 'key-questions')).toBe(true);
    expect(shouldAnalyze([seg('we should decide who is travelling first')], 'key-questions')).toBe(true);
    expect(shouldAnalyze([seg('the plan is to ship before March')], 'key-questions')).toBe(true);
  });

  it('chitchat → suppress', () => {
    expect(shouldAnalyze([seg('the coffee here is fine')], 'key-questions')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — eli5', () => {
  it('acronym → fire', () => {
    expect(shouldAnalyze([seg('the API needs CORS configured for our SPA')], 'eli5')).toBe(true);
  });

  it('jargon suffix → fire', () => {
    expect(shouldAnalyze([seg('the implementation has heavy parallelization')], 'eli5')).toBe(true);
  });

  it('plain conversation → suppress', () => {
    expect(shouldAnalyze([seg('I made pancakes for breakfast')], 'eli5')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — logical-fallacy', () => {
  it('absolute language fires', () => {
    expect(shouldAnalyze([seg("they're always late to these meetings")], 'logical-fallacy')).toBe(true);
    expect(shouldAnalyze([seg('if we cut the budget then everything breaks')], 'logical-fallacy')).toBe(true);
  });

  it('measured statement → suppress', () => {
    expect(shouldAnalyze([seg('that seems reasonable to me')], 'logical-fallacy')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — bias-detector', () => {
  it('group-blanket framing fires', () => {
    expect(shouldAnalyze([seg('they always do this kind of thing')], 'bias-detector')).toBe(true);
    expect(shouldAnalyze([seg('the left wants to ban everything')], 'bias-detector')).toBe(true);
  });

  it('neutral content → suppress', () => {
    expect(shouldAnalyze([seg('I think the weather is changing')], 'bias-detector')).toBe(false);
  });
});

describe('relevanceGate.shouldAnalyze — devils-advocate', () => {
  it('confident assertion fires', () => {
    expect(shouldAnalyze([seg('it is definitely the best option for us')], 'devils-advocate')).toBe(true);
    expect(shouldAnalyze([seg('this is the only way forward')], 'devils-advocate')).toBe(true);
  });
});

describe('relevanceGate.shouldAnalyze — tail window size', () => {
  it('inspects only the last GATE_TAIL_SEGMENTS segments', () => {
    // First-segment-substantive, then GATE_TAIL_SEGMENTS pure-filler. The
    // older substantive line should fall outside the window and the gate
    // should suppress the auto-lens fire.
    const tail: TranscriptSegment[] = [
      seg('the new vaccine cuts severity by 80 percent'),
      ...Array.from({ length: GATE_TAIL_SEGMENTS }, () => seg('yeah')),
    ];
    expect(shouldAnalyze(tail, 'auto')).toBe(false);
  });

  it('tail of exactly GATE_TAIL_SEGMENTS works regardless of size', () => {
    const tail = Array.from({ length: GATE_TAIL_SEGMENTS }, () => seg('okay'));
    expect(shouldAnalyze(tail, 'auto')).toBe(false);
  });
});
