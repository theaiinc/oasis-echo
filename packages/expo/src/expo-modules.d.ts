/**
 * The parts of the Expo modules that expo.ts uses, declared here so this package
 * builds without installing Expo and React Native (their peers) in this repo. Keep in
 * step with the modules' own types (checked against Expo SDK 57).
 */
type Subscription = { remove(): void };

declare module 'expo-speech' {
  export type Voice = { identifier: string; name: string; quality: string; language: string };
  export type SpeechOptions = {
    language?: string; voice?: string; rate?: number; pitch?: number; volume?: number;
    onStart?: () => void; onDone?: () => void; onStopped?: () => void; onError?: (error: Error) => void;
  };
  export function speak(text: string, options?: SpeechOptions): void;
  export function stop(): Promise<void>;
  export function getAvailableVoicesAsync(): Promise<Voice[]>;
}

declare module 'expo-speech-recognition' {
  export const ExpoSpeechRecognitionModule: {
    requestPermissionsAsync(): Promise<{ granted: boolean }>;
    start(options: { lang?: string; interimResults?: boolean; continuous?: boolean; requiresOnDeviceRecognition?: boolean }): void;
    stop(): void;
    abort(): void;
    addListener(event: string, listener: (event: never) => void): Subscription;
  };
}

declare module 'expo-audio' {
  export type AudioPlayer = {
    play(): void;
    pause(): void;
    remove(): void;
    addListener(event: 'playbackStatusUpdate', listener: (status: { didJustFinish?: boolean }) => void): Subscription;
  };
  export function createAudioPlayer(source: { uri: string }): AudioPlayer;
  export function setAudioModeAsync(mode: { playsInSilentMode?: boolean; interruptionMode?: 'mixWithOthers' | 'doNotMix' | 'duckOthers' }): Promise<void>;
}

declare module 'expo-file-system' {
  export class Directory {}
  export const Paths: { cache: Directory };
  export class File {
    constructor(directory: Directory, name: string);
    readonly uri: string;
    write(content: Uint8Array | string): void;
    delete(): void;
  }
}
