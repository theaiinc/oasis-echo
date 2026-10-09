# @theaiinc/oasis-echo-expo

Voice with an oasis-echo server from Expo apps on Android and iOS: `EchoConnection` (the transport, for apps that run
their own turns) and `EchoVoiceSession` (a whole call on top of it).

- **Listening:** the phone's own speech recognition ([expo-speech-recognition]). What the user says is
  sent to the server as a turn.
- **Speaking:** the phone's own voice ([expo-speech], `voice: 'device'`), speaking each reply line as it
  streams in; or the server's voice (`voice: 'server'`), its PCM played as WAV clips with [expo-audio].
- Same rules as the web `VoiceSession`: the mic is off while the agent speaks, so it doesn't hear itself,
  and comes back once the reply is complete and played. Interrupting stops the agent and tells the server.

## Install

```bash
npx expo install @theaiinc/oasis-echo-expo expo-speech expo-speech-recognition expo-audio expo-file-system
```

`app.json` / `app.config`:

```json
{
  "plugins": [
    ["expo-speech-recognition", {
      "microphonePermission": "Talk to your assistant.",
      "speechRecognitionPermission": "Turn what you say into text for your assistant."
    }]
  ]
}
```

Android needs `RECORD_AUDIO`; remove it from `android.blockedPermissions` if your app blocks it. Speech
recognition is a native module: use a development build, not Expo Go.

## Use

```tsx
import { EchoVoiceSession } from '@theaiinc/oasis-echo-expo';
import { createExpoAdapters } from '@theaiinc/oasis-echo-expo/expo';
const session = new EchoVoiceSession({
  baseUrl: 'https://echo.example.com/a/maya',
  adapters: createExpoAdapters(),
  lang: 'vi-VN',
  voice: 'device', // or 'server'
  rate: { vi: 1.15, en: 1.1 },
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});

session.on('state', (s) => setState(s)); // idle | listening | thinking | speaking
session.on('userText', ({ text, final }) => …);
session.on('agentText', ({ text }) => …);
session.on('error', ({ kind, message }) => …);

await session.start(); // asks for the mic, opens the event stream, listens
session.interrupt();   // e.g. a "stop" button while the agent talks
session.setLang('en-US');
session.stop();        // hang up
```

Servers with client actions (hosted Echo): pass `actions: { names(), context(), run(req) }`. The session says hello
with them whenever the stream opens (call `session.refreshActions()` when they change), runs what the agent asks and
posts the result. `session.on('refused', r)` fires when the server says no (401/403/503), with `r.message[lang]` to
speak; `session.on('event', e)` sees every server event.

## EchoConnection: your own turns

Apps with their own turn logic (push-to-talk, a wake word, a native audio pipeline) use the connection directly:

```ts
import { EchoConnection, EchoRefused, base64ToBytes } from '@theaiinc/oasis-echo-expo';

const echo = new EchoConnection({
  url: 'https://echo.example.com/a/arion',
  headers: () => ({ Authorization: `Bearer ${token}` }),
  onEvent: (e) => { /* tts.chunk, turn.complete, action.request, stt.*, bargein, idle, other */ },
  onStream: (state, refusal) => { /* open | closed (+ refusal: stop and say why) */ },
  onSocket: (m) => { /* ready | stt.partial | stt.final from the audio socket */ },
});
await echo.open();                       // the event stream: XHR (React Native has no EventSource), reconnects
await echo.hello({ actions: ['nav_search'], context: { lang: 'vi' } });
await echo.openAudio();                  // the audio socket, with the same headers
echo.startUtterance('u1');
echo.sendAudio(float32Le16kHzBytes);     // mic frames
echo.endUtterance();
await echo.actionResult({ id, ok: true, result });
```

`protocol.ts` has the shapes (`parseEvent`, `parseRefusal`, `actionResultBody`, socket messages, `echoPaths`);
`pcm.ts` the base64 / float32 helpers that work in Hermes without `atob`.

## Adapters

`EchoVoiceSession` itself has no native imports: it talks to the phone through `DeviceSpeech`,
`Recognizer` and `ClipPlayer` (see `adapters.ts`). `createExpoAdapters()` builds them from the Expo
modules; pass your own to use a different engine (e.g. a native module that routes speech to a car's
navigation audio channel) or in tests.

## Not yet

- Server listening inside `EchoVoiceSession` (the connection has the audio socket; the session listens with the
  phone's recognizer for now). Apps with their own mic PCM stream through `EchoConnection`.
- Talking over the agent by voice: the mic is off while it speaks; use `interrupt()`.

[expo-speech-recognition]: https://github.com/jamsch/expo-speech-recognition
[expo-speech]: https://docs.expo.dev/versions/latest/sdk/speech/
[expo-audio]: https://docs.expo.dev/versions/latest/sdk/audio/
