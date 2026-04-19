/**
 * Browser example: wire the full voice stack (SSE + Web Audio +
 * AudioWorklet mic capture + SER emotion + barge-in) using
 * @oasis-echo/sdk — roughly what packages/app/src/index.html does
 * at runtime, minus the UI rendering.
 *
 * Load this from a module script in an HTML page that has a mic
 * button + event log div. Exported helpers below can be wired to
 * your UI framework of choice.
 */

import { OasisClient, TurnDebouncer } from '@oasis-echo/sdk';
import {
  AudioPlayer,
  BargeInMonitor,
  EmotionDetector,
  MicCapture,
} from '@oasis-echo/sdk/browser';

export async function startVoiceStack(opts: {
  baseUrl: string;
  onEvent?: (eventName: string, payload: unknown) => void;
}): Promise<{
  stop: () => void;
  bargeIn: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
}> {
  const client = new OasisClient({ baseUrl: opts.baseUrl });
  const audioCtx = new AudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = audioCtx.createMediaStreamSource(stream);

  const player = new AudioPlayer({ audioContext: audioCtx });
  const mic = new MicCapture();
  await mic.start({ audioContext: audioCtx, source });
  const emotion = new EmotionDetector();
  emotion.preload(); // kick off download in parallel with first utterance

  // Agent-speaking flag drives the barge-in monitor.
  let agentSpeaking = false;
  const bargeIn = new BargeInMonitor({
    isActive: () => agentSpeaking,
    onBargeIn: () => {
      agentSpeaking = false;
      player.stopAll();
      void client.bargeIn();
    },
  });
  bargeIn.start(source);

  // SSE wiring.
  client.on('emotion.directives', (p) => {
    player.setDirectives(p.turnId, p.directives);
    opts.onEvent?.('emotion.directives', p);
  });
  client.on('tts.chunk', (p) => {
    agentSpeaking = true;
    if (p.audio) {
      player.playPcm(p.audio, p.sampleRate, { turnId: p.turnId, filler: p.filler });
    }
    opts.onEvent?.('tts.chunk', p);
  });
  client.on('turn.complete', (p) => {
    player.forgetDirectives(p.turn.id);
    agentSpeaking = false;
    opts.onEvent?.('turn.complete', p);
  });
  client.connect();

  // Browser SpeechRecognition → TurnDebouncer → /turn.
  const SR: typeof window.SpeechRecognition | undefined =
    (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition }).webkitSpeechRecognition;
  if (!SR) throw new Error('SpeechRecognition not supported in this browser');

  const debouncer = new TurnDebouncer({
    silenceMs: 1200,
    onCommit: async (text) => {
      // Classify the last 5s of mic audio opportunistically — detector's
      // own timeout cap keeps this fast.
      const pcm = mic.snapshot(5);
      const detected = pcm
        ? await emotion.classify(pcm, mic.sampleRate, { timeoutMs: 300 })
        : null;
      await client.sendTurn({
        text,
        ...(detected ? { emotion: { label: detected.label, confidence: detected.confidence } } : {}),
      });
    },
  });

  const recognition = new SR() as SpeechRecognition & { maxAlternatives?: number };
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 4;
  recognition.onresult = (ev: SpeechRecognitionEvent) => {
    let interim = '';
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i]!;
      if (r.isFinal) finalText += r[0]!.transcript;
      else interim += r[0]!.transcript;
    }
    if (interim.trim()) debouncer.onInterim(interim);
    if (finalText.trim()) debouncer.onFinal(finalText);
  };
  recognition.start();

  return {
    stop: () => {
      recognition.stop();
      debouncer.cancel();
      bargeIn.stop();
      mic.stop();
      player.stopAll();
      client.close();
      stream.getTracks().forEach((t) => t.stop());
      void audioCtx.close();
    },
    bargeIn: async () => {
      player.stopAll();
      await client.bargeIn();
    },
    sendText: async (text) => {
      await client.sendTurn({ text });
    },
  };
}
