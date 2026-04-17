export type Redaction = {
  placeholder: string;
  original: string;
  kind: 'email' | 'phone' | 'ssn' | 'card' | 'ip';
};

export type RedactionResult = {
  text: string;
  redactions: Redaction[];
};

const PATTERNS: Array<{ kind: Redaction['kind']; re: RegExp }> = [
  { kind: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { kind: 'phone', re: /\b(?:\+?\d{1,2}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g },
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'card', re: /\b(?:\d[ -]*?){13,16}\b/g },
  { kind: 'ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

/**
 * Replaces PII with stable placeholders before sending to the cloud.
 * Call `rehydrate` on the cloud response to restore original values
 * before they reach the user's speaker.
 */
export class PiiRedactor {
  redact(text: string): RedactionResult {
    let out = text;
    const redactions: Redaction[] = [];
    for (const { kind, re } of PATTERNS) {
      out = out.replace(re, (match) => {
        const existing = redactions.find((r) => r.original === match);
        if (existing) return existing.placeholder;
        const placeholder = `<${kind.toUpperCase()}_${redactions.filter((r) => r.kind === kind).length + 1}>`;
        redactions.push({ placeholder, original: match, kind });
        return placeholder;
      });
    }
    return { text: out, redactions };
  }

  rehydrate(text: string, redactions: Redaction[]): string {
    let out = text;
    for (const r of redactions) {
      // escape for regex use
      const escaped = r.placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), r.original);
    }
    return out;
  }
}
