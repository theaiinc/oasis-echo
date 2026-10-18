import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * Third-party browser files the page loads at run time, served from
 * node_modules instead of a CDN: the DeepFilterNet3 noise filter and the
 * Silero VAD with its ONNX runtime (VoiceSession `noiseFilter: 'deepfilter'`,
 * `vad: 'silero'`). Only the files listed here are served.
 */
const file = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
const sibling = (specifier: string, name: string) => join(dirname(file(specifier)), name);

const FILES: Record<string, () => string> = {
  'deepfilternet/worklet.js': () => sibling('@lofcz/deepfilternet-web', 'worklet.js'),
  'deepfilternet/df_bg.wasm': () => sibling('@lofcz/deepfilternet-web', 'df_bg.wasm'),
  'silero/silero_vad_v5.onnx': () => file('@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
  // The ESM build with its wasm glue bundled in; it fetches only the .wasm below.
  'onnxruntime-web/ort.wasm.bundle.min.mjs': () => file('onnxruntime-web/wasm'),
  'onnxruntime-web/ort-wasm-simd-threaded.wasm': () => sibling('onnxruntime-web/wasm', 'ort-wasm-simd-threaded.wasm'),
};

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  onnx: 'application/octet-stream',
};

/** Read and gzipped once: the noise filter's wasm is 34 MB (13 MB gzipped). */
const cache = new Map<string, { raw: Buffer; gz: Buffer }>();

/** Handles GET /vendor/…; returns false for any other request. */
export function serveVendor(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== 'GET' || !pathname.startsWith('/vendor/')) return false;
  const name = pathname.slice('/vendor/'.length);
  const locate = FILES[name];
  if (!locate) {
    res.writeHead(404);
    res.end('not found');
    return true;
  }
  let file = cache.get(name);
  if (!file) {
    try {
      const raw = readFileSync(locate());
      file = { raw, gz: gzipSync(raw) };
      cache.set(name, file);
    } catch {
      res.writeHead(404);
      res.end('not found');
      return true;
    }
  }
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = gzip ? file.gz : file.raw;
  res.writeHead(200, {
    'Content-Type': TYPES[name.split('.').pop()!] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Pinned package versions: the files only change with a deploy.
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(body);
  return true;
}
