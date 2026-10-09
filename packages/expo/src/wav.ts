/**
 * The server's voice arrives as base64 16-bit mono PCM chunks; native players want a
 * file. Wrap PCM in a WAV header (no resampling, no copies beyond the one buffer). Base64 is in pcm.ts.
 */

/** A WAV file holding these 16-bit little-endian mono PCM chunks back to back. */
export function pcm16ToWav(chunks: Uint8Array[], sampleRate: number): Uint8Array {
  const dataLen = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  v.setUint32(40, dataLen, true);
  let at = 44;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** How long these PCM bytes play, in ms. */
export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return Math.round((bytes / 2 / sampleRate) * 1000);
}
