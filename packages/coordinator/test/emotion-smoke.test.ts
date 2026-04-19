import { describe, it } from 'vitest';
import { EmotionAdaptiveTts } from '../src/emotion/index.js';
import type { Emotion } from '../src/emotion/index.js';

/**
 * Smoke "test" — prints the directive table the server would broadcast
 * for each SER emotion. Run with:
 *
 *   npx vitest run packages/coordinator/test/emotion-smoke.test.ts --reporter=verbose
 *
 * No assertions — this is here to make it easy to eyeball the output
 * table when tuning baselines. The audible-delta test enforces the
 * actual regressions.
 */
describe('emotion → directives smoke table', () => {
  const adapter = new EmotionAdaptiveTts();
  const labels: Array<{ label: string; emotion: Emotion }> = [
    { label: 'NEU (neutral)',  emotion: 'neutral' },
    { label: 'CAL (calm)',     emotion: 'calm' },
    { label: 'HAP (happy)',    emotion: 'happy' },
    { label: 'SUR (surprise)', emotion: 'surprise' },
    { label: 'ANG (angry)',    emotion: 'angry' },
    { label: 'SAD (sad)',      emotion: 'sad' },
    { label: 'FEA (fear)',     emotion: 'fear' },
    { label: 'DIS (disgust)',  emotion: 'disgust' },
  ];

  it('prints the full table (always passes)', () => {
    const rows: string[] = [];
    rows.push(
      'emotion               | strategy      | rate | gain | pause(ms) | pitch(st) | styles',
    );
    rows.push(
      '---------------------+---------------+------+------+-----------+-----------+-------------------',
    );
    for (const { label, emotion } of labels) {
      const { output, directives } = adapter.adapt({
        text: 'Here is my response.',
        emotion,
        confidence: 0.85,
      });
      rows.push(
        [
          label.padEnd(21),
          output.strategyApplied.padEnd(14),
          directives.playbackRate.toFixed(3).padStart(5),
          directives.gain.toFixed(3).padStart(5),
          String(directives.interChunkSilenceMs).padStart(9),
          String(directives.pitchSemitones).padStart(9),
          output.styleTags.join(', '),
        ].join(' | '),
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
  });

  it('prints one full SSML sample for "frustrated"', () => {
    const { directives, output } = adapter.adapt({
      text: 'I hear you. Let me help you with that, right now.',
      emotion: 'frustrated',
      confidence: 0.85,
    });
    // eslint-disable-next-line no-console
    console.log('\n--- SAMPLE SSML (frustrated + soften) ---');
    // eslint-disable-next-line no-console
    console.log(`rationale: ${output.rationale}`);
    // eslint-disable-next-line no-console
    console.log(directives.ssml);
    // eslint-disable-next-line no-console
    console.log('--- end ---\n');
  });
});
