import { describe, expect, it } from 'vitest';
import { DeviceSpeaker, pickVoice } from '../src/browser/device-speaker.js';

const v = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, localService: true, default: false, voiceURI: name, ...extra }) as SpeechSynthesisVoice;

class FakeUtterance {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeSynth(voices: SpeechSynthesisVoice[]) {
  const spoken: FakeUtterance[] = [];
  let cancelled = 0;
  const synth = {
    getVoices: () => voices,
    speak: (u: FakeUtterance) => spoken.push(u),
    cancel: () => { cancelled++; },
  } as unknown as SpeechSynthesis;
  return { synth, spoken, cancelled: () => cancelled };
}

describe('pickVoice', () => {
  it('prefers the exact locale, then the better-sounding voices', () => {
    const voices = [v('Alex', 'en-US'), v('Linh', 'vi-VN'), v('Google Tiếng Việt', 'vi-VN', { localService: false }), v('Daniel', 'en-GB')];
    expect(pickVoice(voices, 'vi-VN')!.name).toBe('Google Tiếng Việt');
    expect(pickVoice(voices, 'en-GB')!.name).toBe('Daniel');
    expect(pickVoice(voices, 'en-AU')!.lang).toMatch(/^en-/); // the language, any locale
    expect(pickVoice(voices, 'fr-FR')).toBeNull();
  });

  it('accepts underscore locales (Android)', () => {
    expect(pickVoice([v('Linh', 'vi_VN')], 'vi-VN')!.name).toBe('Linh');
  });
});

describe('DeviceSpeaker', () => {
  it('queues text in the language, and says when everything has been said', () => {
    const { synth, spoken } = fakeSynth([v('Linh', 'vi-VN')]);
    let ended = 0;
    const s = new DeviceSpeaker({ synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance, onEnd: () => ended++ });
    s.speak('Dạ, em chào anh.', 'vi-VN');
    s.speak('  ', 'vi-VN'); // nothing to say
    s.speak('Anh cần gì ạ?', 'vi-VN');
    expect(spoken.map((u) => [u.text, u.lang, u.voice?.name])).toEqual([['Dạ, em chào anh.', 'vi-VN', 'Linh'], ['Anh cần gì ạ?', 'vi-VN', 'Linh']]);
    expect(s.activeCount).toBe(2);
    spoken[0]!.onend!();
    expect(ended).toBe(0);
    spoken[1]!.onerror!();
    expect(ended).toBe(1);
    expect(s.activeCount).toBe(0);
  });

  it('stops everything at once, and speaks muted when the speaker is off', () => {
    const f = fakeSynth([]);
    let ended = 0;
    const s = new DeviceSpeaker({ synth: f.synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance, onEnd: () => ended++ });
    s.setVolume(0);
    s.speak('one', 'en-US');
    expect(f.spoken[0]!.volume).toBe(0);
    s.stopAll();
    expect(f.cancelled()).toBe(1);
    expect(s.activeCount).toBe(0);
    f.spoken[0]!.onend!(); // the cancelled utterance ending later changes nothing
    expect(ended).toBe(0);
  });
});
