import type { AudioChunk } from '@oasis-echo/types';

export type SttPartial = {
  turnId: string;
  text: string;
  stable: boolean;
  atMs: number;
};

export type SttFinal = {
  turnId: string;
  text: string;
  atMs: number;
};

export interface StreamingStt {
  /**
   * Begin a new utterance. Returns a controller for feeding audio and
   * receiving partials; resolves the final transcript on close.
   */
  openTurn(turnId: string): SttTurn;
}

export interface SttTurn {
  feed(chunk: AudioChunk): void;
  readonly partials: AsyncIterable<SttPartial>;
  close(): Promise<SttFinal>;
  cancel(): void;
}

/**
 * Mock STT that treats each AudioChunk's `pcm` as UTF-8-encoded text bytes
 * and emits word-by-word partials. Lets the full pipeline run end-to-end
 * without a real STT engine in tests and the text-mode demo.
 */
export class MockTextStt implements StreamingStt {
  openTurn(turnId: string): SttTurn {
    return new MockSttTurn(turnId);
  }
}

class MockSttTurn implements SttTurn {
  private buffer = '';
  private readonly queue: SttPartial[] = [];
  private resolveWaiter: (() => void) | null = null;
  private closed = false;
  private cancelled = false;

  constructor(private readonly turnId: string) {}

  feed(chunk: AudioChunk): void {
    if (this.closed || this.cancelled) return;
    const text = new TextDecoder().decode(new Uint8Array(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength));
    this.buffer += text;
    this.queue.push({
      turnId: this.turnId,
      text: this.buffer,
      stable: false,
      atMs: Date.now(),
    });
    this.resolveWaiter?.();
    this.resolveWaiter = null;
  }

  partials = (() => {
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        while (!self.closed && !self.cancelled) {
          if (self.queue.length > 0) {
            const p = self.queue.shift()!;
            yield p;
            continue;
          }
          await new Promise<void>((r) => {
            self.resolveWaiter = r;
          });
        }
      },
    };
  })();

  async close(): Promise<SttFinal> {
    this.closed = true;
    this.resolveWaiter?.();
    return { turnId: this.turnId, text: this.buffer.trim(), atMs: Date.now() };
  }

  cancel(): void {
    this.cancelled = true;
    this.resolveWaiter?.();
  }
}
