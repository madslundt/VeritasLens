import type { LensResult } from '../types';

/**
 * Produces a short, audio-optimised summary string for a given LensResult.
 * Intended for TTS output (e.g. Ray-Ban Meta speaker). The switch is
 * exhaustive so TypeScript will error at build time if a variant is added to
 * LensResult without being handled here.
 */
export function toSpeech(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': {
      const total = result.claims.length;
      const trueCount = result.claims.filter((c) => c.verdict === 'TRUE').length;
      const falseCount = result.claims.filter((c) => c.verdict === 'FALSE').length;
      const unverifiedCount = result.claims.filter((c) => c.verdict === 'UNVERIFIED').length;
      return `${total} claims — ${trueCount} true, ${falseCount} false, ${unverifiedCount} unverifiable.`;
    }

    case 'translation':
      return result.translatedText;

    case 'eli5': {
      const first = result.claims[0];
      return first?.explanation ?? first?.oneLine ?? '';
    }

    case 'session-summary':
      return `Session summary: ${result.title}.`;

    case 'logical-fallacy': {
      const count = result.claims.length;
      return `${count} logical ${count === 1 ? 'fallacy' : 'fallacies'} detected.`;
    }

    case 'bias': {
      const n = result.claims.filter((c) => c.verdict === 'BIASED').length;
      if (n === 0) return 'No bias detected.';
      return `${n} biased claim${n === 1 ? '' : 's'} detected.`;
    }

    case 'trivia': {
      const first = result.claims[0];
      return `Trivia: ${first?.question ?? ''}`;
    }

    case 'meeting-prep': {
      const count = result.claims.length;
      return `${count} meeting prep ${count === 1 ? 'point' : 'points'}.`;
    }

    case 'devils-advocate': {
      const count = result.claims.length;
      return `${count} devil's advocate ${count === 1 ? 'point' : 'points'}.`;
    }

    case 'key-questions': {
      const first = result.claims[0];
      return `Key question: ${first?.question ?? ''}`;
    }

    case 'companion': {
      const first = result.claims[0];
      return first?.headline ?? '';
    }

    case 'game':
      return `Game complete. Score: ${result.score} of ${result.questions.length}.`;
  }
}
