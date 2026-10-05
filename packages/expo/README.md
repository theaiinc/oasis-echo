# @oasis-echo/expo

Voice calls with an oasis-echo server from Expo apps on Android and iOS.

- **Listening:** the phone's own speech recognition ([expo-speech-recognition]). What the user says is
  sent to the server as a turn.
- **Speaking:** the phone's own voice ([expo-speech], `voice: 'device'`), speaking each reply line as it
  streams in; or the server's voice (`voice: 'server'`), its PCM played as WAV clips with [expo-audio].
- Same rules as the web `VoiceSession`: the mic is off while the agent speaks, so it doesn't hear itself,
  and comes back once the reply is complete and played. Interrupting stops the agent and tells the server.

## Install

```bash
npx expo install @oasis-echo/expo @oasis-echo/sdk expo-speech expo-speech-recognition expo-audio expo-file-system
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
import { EchoVoiceSession } from '@oasis-echo/expo';
import { createExpoAdapters } from '@oasis-echo/expo/expo';
import { fetch } from 'expo/fetch'; // streams the server's events (React Native's fetch doesn't)

const session = new EchoVoiceSession({
  baseUrl: 'https://echo.example.com/a/maya',
  adapters: createExpoAdapters(),
  fetch,
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

`session.client` is the underlying `OasisClient`; pass `extraEvents` for server events beyond the
built-in ones and read them with `session.client.onEvent(name, …)`.

## Adapters

`EchoVoiceSession` itself has no native imports: it talks to the phone through `DeviceSpeech`,
`Recognizer` and `ClipPlayer` (see `adapters.ts`). `createExpoAdapters()` builds them from the Expo
modules; pass your own to use a different engine (e.g. a native module that routes speech to a car's
navigation audio channel) or in tests.

## Not yet

- Server listening (streaming the mic to the server's `/audio` socket, which is faster and can tell the
  user's voice from others'): needs raw microphone PCM, e.g. via react-native-audio-api.
- Talking over the agent by voice: the mic is off while it speaks; use `interrupt()`.

[expo-speech-recognition]: https://github.com/jamsch/expo-speech-recognition
[expo-speech]: https://docs.expo.dev/versions/latest/sdk/speech/
[expo-audio]: https://docs.expo.dev/versions/latest/sdk/audio/
