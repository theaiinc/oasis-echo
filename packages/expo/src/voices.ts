/** A system voice, as expo-speech lists them. */
export type SystemVoice = { identifier: string; name: string; language: string; quality?: string };

/**
 * The best system voice for a language (e.g. "vi-VN"): exact locale before the same
 * language elsewhere; network voices (Android's Google "-network" ones sound best),
 * then enhanced/premium, then the rest; novelty voices never. Undefined: none for that
 * language (the platform default is used, which may be another language's).
 */
export function chooseVoice(voices: SystemVoice[], lang: string): SystemVoice | undefined {
  const want = lang.toLowerCase().replace('_', '-');
  const base = want.split('-')[0]!;
  const novelty = /bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|pipe organ|trinoids|whisper|zarvox|jester|superstar|organ/i;
  const score = (v: SystemVoice): number => {
    const l = v.language.toLowerCase().replace('_', '-');
    if (!l.startsWith(base) || novelty.test(v.name)) return -1;
    let s = l === want ? 100 : 50;
    const id = `${v.identifier} ${v.name}`.toLowerCase();
    if (id.includes('network')) s += 30;
    if (v.quality === 'Enhanced' || /premium|enhanced/.test(id)) s += 20;
    if (id.includes('local') || id.includes('compact')) s -= 5;
    return s;
  };
  let best: SystemVoice | undefined;
  let bestScore = -1;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return bestScore >= 0 ? best : undefined;
}
