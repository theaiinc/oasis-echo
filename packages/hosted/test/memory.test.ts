import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirFactStore, HearingFixes, KeptFacts, WorkingNotes, userKey } from '../src/memory.js';
import { progressNote } from '../src/experts.js';

describe('working notes', () => {
  it('fade once unused for the TTL, and reading keeps them fresh', () => {
    let now = 0;
    const notes = new WorkingNotes({ ttlMs: 1_000, now: () => now });
    notes.put('a', 'Maya said Arion One needs attention.');
    now = 900;
    expect(notes.read()).toHaveLength(1);
    now = 1_800;
    expect(notes.read()).toHaveLength(1);
    now = 3_000;
    expect(notes.read()).toEqual([]);
  });

  it('drop the oldest first when over the size budget, and a key replaces its note', () => {
    const notes = new WorkingNotes({ maxChars: 30 });
    notes.put('a', 'first note, fairly long');
    notes.put('b', 'second note');
    notes.put('b', 'second, replaced');
    expect(notes.read()).toEqual(['second, replaced']);
  });
});

describe('kept facts', () => {
  it('persist per user across loads, and forget removes them', async () => {
    const store = new DirFactStore(await mkdtemp(join(tmpdir(), 'echo-memory-')));
    const key = userKey('user-1');
    const first = new KeptFacts(store, key);
    await first.remember('Steve prefers answers in Vietnamese.');
    await first.remember('Steve prefers answers in Vietnamese.');
    await first.remember('The Arion launch is on Friday.');
    const again = new KeptFacts(store, key);
    await again.loaded;
    expect(again.list()).toEqual(['Steve prefers answers in Vietnamese.', 'The Arion launch is on Friday.']);
    expect(await again.forget('arion')).toEqual({ ok: true, removed: 1 });
    const third = new KeptFacts(store, key);
    await third.loaded;
    expect(third.list()).toEqual(['Steve prefers answers in Vietnamese.']);
    const other = new KeptFacts(store, userKey('user-2'));
    await other.loaded;
    expect(other.list()).toEqual([]);
  });
});

describe('desk progress notes', () => {
  it('are fixed lines, so the voice can prepare them ahead of time', () => {
    expect(progressNote(1)).toBe(progressNote(1));
    expect(progressNote(2)).not.toBe(progressNote(1));
  });
});

describe('hearing fixes', () => {
  it('fixes corrected mishearings in later transcripts, whole words only', () => {
    const h = new HearingFixes();
    h.add('Orion', 'Arion');
    h.add('book keeper', 'Bookkeeper');
    h.add('tiếng nhặt', 'tiếng Nhật');
    expect(h.apply('What about orion one?')).toBe('What about Arion one?');
    expect(h.apply('Check the book  keeper board')).toBe('Check the Bookkeeper board');
    expect(h.apply('Horizon')).toBe('Horizon');
    expect(h.apply('Nói tiếng nhặt đi')).toBe('Nói tiếng Nhật đi');
    expect(h.add('same', 'Same')).toBe(false);
  });
});
