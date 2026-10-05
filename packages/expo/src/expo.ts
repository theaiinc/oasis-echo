import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import type { ClipPlayer, DeviceSpeech, EchoAdapters, Recognizer, RecognizerEvent } from './adapters.js';

/**
 * The session's adapters on a real phone: expo-speech (the phone's voice),
 * expo-speech-recognition (listening) and expo-audio + expo-file-system (the server's
 * voice). Add "expo-speech-recognition" to your app config plugins, with the
 * microphone / speech recognition usage strings.
 */
export function createExpoAdapters(opts: { serverVoice?: boolean } = {}): EchoAdapters {
  return {
    speech: expoSpeech(),
    recognizer: expoRecognizer(),
    ...(opts.serverVoice === false ? {} : { player: expoClipPlayer() }),
  };
}

export function expoSpeech(): DeviceSpeech {
  return {
    speak(text, o) {
      Speech.speak(text, {
        language: o.language,
        ...(o.voice ? { voice: o.voice } : {}),
        ...(o.rate ? { rate: o.rate } : {}),
        ...(o.onStart ? { onStart: o.onStart } : {}),
        onDone: o.onDone,
        // Stopped (barged in) counts as done for the queue; the session already dropped the rest.
        onStopped: o.onDone,
        onError: o.onError,
      });
    },
    stop() {
      void Speech.stop();
    },
    async voices() {
      return (await Speech.getAvailableVoicesAsync()).map((v) => ({ identifier: v.identifier, name: v.name, language: v.language, quality: String(v.quality) }));
    },
  };
}

type Sub = { remove(): void };
type Emitter = { addListener(name: string, cb: (e: never) => void): Sub };

export function expoRecognizer(): Recognizer {
  const mod = ExpoSpeechRecognitionModule;
  const events = mod as unknown as Emitter;
  return {
    async requestPermissions() {
      const r = await mod.requestPermissionsAsync();
      return r.granted;
    },
    start(o) {
      mod.start({ lang: o.lang, interimResults: o.interimResults, continuous: o.continuous, ...(o.onDevice ? { requiresOnDeviceRecognition: true } : {}) });
    },
    stop() {
      mod.stop();
    },
    abort() {
      mod.abort();
    },
    listen(cb) {
      const subs: Sub[] = [
        events.addListener('start', () => cb({ type: 'start' })),
        events.addListener('speechstart', () => cb({ type: 'speechstart' })),
        events.addListener('end', () => cb({ type: 'end' })),
        events.addListener('result', (e: { isFinal: boolean; results: Array<{ transcript: string }> }) =>
          cb({ type: 'result', text: e.results[0]?.transcript ?? '', isFinal: e.isFinal })),
        events.addListener('error', (e: { error: string; message?: string }) =>
          cb({ type: 'error', error: e.error, ...(e.message ? { message: e.message } : {}) } as RecognizerEvent)),
      ];
      return () => { for (const s of subs) s.remove(); };
    },
  };
}

/** Plays WAV clips one after another, from files in the cache directory. */
export function expoClipPlayer(): ClipPlayer {
  const queue: Array<{ wav: Uint8Array; onEnd: () => void }> = [];
  let current: { player: ReturnType<typeof createAudioPlayer>; file: File; onEnd: () => void } | null = null;
  let seq = 0;
  let configured = false;
  const finish = () => {
    const c = current;
    current = null;
    if (c) {
      try { c.player.remove(); } catch { /* already gone */ }
      try { c.file.delete(); } catch { /* best effort */ }
      c.onEnd();
    }
    next();
  };
  const next = () => {
    if (current) return;
    const item = queue.shift();
    if (!item) return;
    if (!configured) {
      configured = true;
      void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'duckOthers' }).catch(() => undefined);
    }
    const file = new File(Paths.cache, `echo-${Date.now()}-${++seq}.wav`);
    file.write(item.wav);
    const player = createAudioPlayer({ uri: file.uri });
    current = { player, file, onEnd: item.onEnd };
    (player as unknown as Emitter).addListener('playbackStatusUpdate', (s: { didJustFinish?: boolean }) => {
      if (s.didJustFinish && current?.player === player) finish();
    });
    player.play();
  };
  return {
    play(wav, onEnd) {
      queue.push({ wav, onEnd });
      next();
    },
    stop() {
      const dropped = queue.splice(0);
      if (current) {
        try { current.player.pause(); } catch { /* ignore */ }
        finish();
      }
      for (const d of dropped) d.onEnd();
    },
  };
}
