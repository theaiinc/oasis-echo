// A server-sent events parser that is fed the stream's text as it arrives, in whatever pieces the network delivers.
// React Native has no EventSource; EchoConnection reads the server's /events through XMLHttpRequest's progress events
// and hands the new text here. Pure, so it runs under `node --test`.

export type SseMessage = { event: string; data: string; id: string | null };

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;
  private afterCr = false;
  /** The server's `retry:` advice, in ms, when it sent one. */
  retryMs: number | null = null;

  /** Feeds new text; returns the events it completed. */
  push(text: string): SseMessage[] {
    // A \r that ended the last piece was a whole line ending; a \n right after it is its other half, not a blank line.
    if (this.afterCr && text.startsWith('\n')) text = text.slice(1);
    this.afterCr = text.endsWith('\r');
    this.buffer += text;
    const out: SseMessage[] = [];
    // Lines end in \n, \r\n or \r. The last piece may be a partial line: keep it for the next push.
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // a comment (the server's pings)
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    return out;
  }

  reset(): void {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.afterCr = false;
  }
}
