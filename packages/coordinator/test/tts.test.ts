import { describe, expect, it } from 'vitest';
import { PassthroughTts, SentenceChunker } from '../src/tts.js';

describe('SentenceChunker', () => {
  it('splits on sentence boundaries', () => {
    const c = new SentenceChunker();
    expect(c.feed('Hello world.')).toEqual(['Hello world.']);
    expect(c.feed(' How are ')).toEqual([]);
    expect(c.feed('you today?')).toEqual(['How are you today?']);
  });

  it('flushes trailing text without punctuation', () => {
    const c = new SentenceChunker();
    c.feed('Hello');
    expect(c.flush()).toBe('Hello');
    expect(c.flush()).toBeNull();
  });

  it('handles multiple boundaries in one feed', () => {
    const c = new SentenceChunker();
    expect(c.feed('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
});

describe('PassthroughTts', () => {
  it('emits a chunk per sentence and marks the last as final', async () => {
    const tts = new PassthroughTts();
    const chunks = [];
    for await (const c of tts.synthesize('Hi there. How are you?')) chunks.push(c);
    expect(chunks.length).toBe(2);
    expect(chunks.at(-1)?.final).toBe(true);
    expect(chunks[0]?.final).toBe(false);
    expect(chunks[0]?.text).toBe('Hi there.');
    expect(chunks[1]?.text).toBe('How are you?');
  });

  it('emits text-only chunks (no real PCM)', async () => {
    const tts = new PassthroughTts();
    const chunks = [];
    for await (const c of tts.synthesize('Hello.')) chunks.push(c);
    expect(chunks[0]?.pcm).toBeUndefined();
    expect(chunks[0]?.text).toBe('Hello.');
  });

  it('honors abort signal', async () => {
    const tts = new PassthroughTts();
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = [];
    for await (const c of tts.synthesize('Hello.', { signal: ctrl.signal })) chunks.push(c);
    expect(chunks.length).toBe(0);
  });
});
