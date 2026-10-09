// Test doubles shared by the expo tests.

/** Stands in for the server's event stream: the connection's XMLHttpRequest. */
export class FakeXhr {
  static last: FakeXhr | null = null;
  static all: FakeXhr[] = [];
  readyState = 0;
  status = 0;
  responseText = '';
  url = '';
  headers: Record<string, string> = {};
  aborted = false;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeXhr.last = this; FakeXhr.all.push(this); }
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send() {}
  abort() { this.aborted = true; }
  respond(status: number, body = '') { this.status = status; this.readyState = 2; this.onreadystatechange?.(); if (body) this.push(body); }
  push(text: string) { this.responseText += text; this.readyState = 3; this.onreadystatechange?.(); }
  event(type: string, data: unknown) { this.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
  end() { this.readyState = 4; this.onreadystatechange?.(); }
}

