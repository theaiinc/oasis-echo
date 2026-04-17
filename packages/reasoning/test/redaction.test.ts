import { describe, expect, it } from 'vitest';
import { PiiRedactor } from '../src/redaction.js';

describe('PiiRedactor', () => {
  it('redacts emails', () => {
    const r = new PiiRedactor();
    const res = r.redact('contact me at alice@example.com please');
    expect(res.text).not.toContain('alice@example.com');
    expect(res.text).toContain('<EMAIL_1>');
    expect(res.redactions[0]?.kind).toBe('email');
  });

  it('redacts phone numbers and SSNs', () => {
    const r = new PiiRedactor();
    const res = r.redact('call (415) 555-0101 or SSN 123-45-6789');
    expect(res.text).not.toContain('415');
    expect(res.text).not.toContain('123-45-6789');
  });

  it('roundtrips via rehydrate', () => {
    const r = new PiiRedactor();
    const original = 'alice@example.com is the address';
    const { text, redactions } = r.redact(original);
    const back = r.rehydrate(text, redactions);
    expect(back).toBe(original);
  });

  it('rehydrates inside a larger reply', () => {
    const r = new PiiRedactor();
    const { text, redactions } = r.redact('send to alice@example.com');
    const cloudResponse = `I will send the note to ${text.match(/<EMAIL_1>/)?.[0]} now.`;
    const rehydrated = r.rehydrate(cloudResponse, redactions);
    expect(rehydrated).toContain('alice@example.com');
  });

  it('reuses placeholders for duplicate values', () => {
    const r = new PiiRedactor();
    const { text, redactions } = r.redact('email bob@x.com and bob@x.com again');
    expect(redactions.length).toBe(1);
    expect((text.match(/<EMAIL_1>/g) ?? []).length).toBe(2);
  });
});
