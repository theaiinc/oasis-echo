// PCM and base64 helpers: mic frames often come from native code as base64 float32 and go to the server as binary;
// the server's speech comes back as base64 int16. Pure (no Buffer, no atob), so it runs under `node --test` and in
// Hermes alike.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // base64url too
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  let n = 0;
  const clean = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) {
    const v = LOOKUP[b64.charCodeAt(i) & 0xff]!;
    if (v >= 0 && b64.charCodeAt(i) < 256) clean[n++] = v;
  }
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < n; i += 4) {
    const a = clean[i]!, b = clean[i + 1]!, c = i + 2 < n ? clean[i + 2]! : 0, d = i + 3 < n ? clean[i + 3]! : 0;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (i + 2 < n && o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (i + 3 < n && o < out.length) out[o++] = triple & 0xff;
  }
  return out.subarray(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const t = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET.charAt((t >> 18) & 63) + ALPHABET.charAt((t >> 12) & 63) + ALPHABET.charAt((t >> 6) & 63) + ALPHABET.charAt(t & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const t = bytes[i]! << 16;
    out += `${ALPHABET.charAt((t >> 18) & 63)}${ALPHABET.charAt((t >> 12) & 63)}==`;
  } else if (rest === 2) {
    const t = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${ALPHABET.charAt((t >> 18) & 63)}${ALPHABET.charAt((t >> 12) & 63)}${ALPHABET.charAt((t >> 6) & 63)}=`;
  }
  return out;
}

/** Little-endian float32 samples from raw bytes (any alignment). */
export function bytesToFloat32(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Float32 samples as little-endian bytes: the binary frame Echo's audio socket takes. */
export function float32ToBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i]!, true);
  return out;
}

/** Root-mean-square level of a frame, 0..1 for float audio. */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** Milliseconds of audio in base64 16-bit mono PCM at `sampleRate` (to know when Echo's speech will have played). */
export function int16Base64DurationMs(b64: string, sampleRate: number): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  return sampleRate > 0 ? Math.round((bytes / 2 / sampleRate) * 1000) : 0;
}
