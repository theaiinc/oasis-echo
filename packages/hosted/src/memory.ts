import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * What the talker knows, instead of a long chat history.
 *
 * - Working notes live in memory only and fade: each is dropped once it has gone
 *   unused for `ttlMs`, and the oldest go first when the total gets long.
 * - Kept facts are what the user explicitly asked to be remembered ("remember
 *   that…", "don't make me repeat…"). They persist per user until forgotten.
 */
export class WorkingNotes {
  private readonly notes: Array<{ key: string; text: string; lastUsed: number }> = [];

  constructor(private readonly opts: { ttlMs?: number; maxChars?: number; now?: () => number } = {}) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Add or replace a note (same key replaces). */
  put(key: string, text: string): void {
    const i = this.notes.findIndex((n) => n.key === key);
    if (i >= 0) this.notes.splice(i, 1);
    this.notes.push({ key, text: text.trim(), lastUsed: this.now });
  }

  /** The notes still fresh, newest last, within the size budget. Reading counts as use. */
  read(): string[] {
    const ttl = this.opts.ttlMs ?? 15 * 60_000;
    const now = this.now;
    for (let i = this.notes.length - 1; i >= 0; i--) if (now - this.notes[i]!.lastUsed > ttl) this.notes.splice(i, 1);
    const max = this.opts.maxChars ?? 2_000;
    while (this.notes.length > 1 && this.notes.reduce((n, x) => n + x.text.length, 0) > max) this.notes.shift();
    for (const n of this.notes) n.lastUsed = now;
    return this.notes.map((n) => n.text);
  }
}

export type KeptFact = { text: string; at: number };

/** Where kept facts are stored: one small JSON document per user. */
export interface FactStore {
  load(userKey: string): Promise<KeptFact[]>;
  save(userKey: string, facts: KeptFact[]): Promise<void>;
}

/** A user's id as a file name that reveals nothing about them. */
export function userKey(sub: string): string {
  return createHash('sha256').update(sub).digest('hex').slice(0, 32);
}

/** Local directory store (development). */
export class DirFactStore implements FactStore {
  constructor(private readonly dir: string) {}
  async load(key: string): Promise<KeptFact[]> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as KeptFact[];
    } catch {
      return [];
    }
  }
  async save(key: string, facts: KeptFact[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(facts));
  }
}

/** Cloud Storage store, authenticated as the Cloud Run service account (metadata server). */
export class GcsFactStore implements FactStore {
  private token: { value: string; until: number } | null = null;

  constructor(private readonly bucket: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async auth(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!res.ok) throw new Error(`metadata token ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private object(key: string): string {
    return encodeURIComponent(`memory/${key}.json`);
  }

  async load(key: string): Promise<KeptFact[]> {
    const res = await this.fetchImpl(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${this.object(key)}?alt=media`, {
      headers: { authorization: `Bearer ${await this.auth()}` },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`memory load ${res.status}`);
    return (await res.json()) as KeptFact[];
  }

  async save(key: string, facts: KeptFact[]): Promise<void> {
    const res = await this.fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${this.object(key)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.auth()}`, 'content-type': 'application/json' },
      body: JSON.stringify(facts),
    });
    if (!res.ok) throw new Error(`memory save ${res.status}`);
  }
}

/** One user's kept facts, loaded once and written back on change. */
export class KeptFacts {
  private facts: KeptFact[] = [];
  readonly loaded: Promise<void>;

  constructor(private readonly store: FactStore | null, private readonly key: string, private readonly logger?: Logger, private readonly max = 50) {
    this.loaded = store
      ? store.load(key).then((f) => { this.facts = f; }).catch((err) => logger?.warn('memory load failed', { error: String(err) }))
      : Promise.resolve();
  }

  list(): string[] {
    return this.facts.map((f) => f.text);
  }

  async remember(text: string): Promise<{ ok: boolean; count: number }> {
    await this.loaded;
    const t = text.trim();
    if (!t) return { ok: false, count: this.facts.length };
    this.facts = this.facts.filter((f) => f.text.toLowerCase() !== t.toLowerCase());
    this.facts.push({ text: t, at: Date.now() });
    while (this.facts.length > this.max) this.facts.shift();
    return { ok: await this.persist(), count: this.facts.length };
  }

  /** Forget facts containing `text` (case-insensitive), or all of them for "everything". */
  async forget(text: string): Promise<{ ok: boolean; removed: number }> {
    await this.loaded;
    const t = text.trim().toLowerCase();
    const before = this.facts.length;
    this.facts = t === 'everything' || t === 'all' ? [] : this.facts.filter((f) => !f.text.toLowerCase().includes(t));
    return { ok: await this.persist(), removed: before - this.facts.length };
  }

  private async persist(): Promise<boolean> {
    if (!this.store) return true;
    try {
      await this.store.save(this.key, this.facts);
      return true;
    } catch (err) {
      this.logger?.warn('memory save failed', { error: String(err) });
      return false;
    }
  }
}

/**
 * Mishearings the user corrected during a call ("no, I said Arion"), applied to every
 * later transcript before the talker sees it: a word swap, so it costs no time.
 */
export class HearingFixes {
  private readonly fixes: Array<{ heard: string; meant: string; re: RegExp }> = [];

  add(heard: string, meant: string): boolean {
    const h = heard.trim();
    const m = meant.trim();
    if (!h || !m || h.toLowerCase() === m.toLowerCase() || h.length > 60) return false;
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Whole words only (Unicode-aware, so Vietnamese words work too).
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    const at = this.fixes.findIndex((f) => f.heard.toLowerCase() === h.toLowerCase());
    if (at >= 0) this.fixes.splice(at, 1);
    this.fixes.push({ heard: h, meant: m, re });
    while (this.fixes.length > 30) this.fixes.shift();
    return true;
  }

  apply(text: string): string {
    return this.fixes.reduce((t, f) => t.replace(f.re, f.meant), text);
  }

  list(): string[] {
    return this.fixes.map((f) => `"${f.heard}" means "${f.meant}"`);
  }
}
