import type { EventType, EventOf, PipelineEvent } from '@oasis-echo/types';

export type Handler<T extends EventType> = (event: EventOf<T>) => void | Promise<void>;
export type AnyHandler = (event: PipelineEvent) => void | Promise<void>;

type ErasedHandler = (event: PipelineEvent) => void | Promise<void>;

/**
 * Minimal typed event bus. Handlers run sequentially per emission so
 * barge-in events can't race ahead of the in-flight turn's state updates.
 */
export class EventBus {
  private readonly typed = new Map<EventType, Set<ErasedHandler>>();
  private readonly wildcard = new Set<AnyHandler>();

  on<T extends EventType>(type: T, handler: Handler<T>): () => void {
    let bucket = this.typed.get(type);
    if (!bucket) {
      bucket = new Set();
      this.typed.set(type, bucket);
    }
    const erased = handler as ErasedHandler;
    bucket.add(erased);
    return () => bucket!.delete(erased);
  }

  onAny(handler: AnyHandler): () => void {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  async emit(event: PipelineEvent): Promise<void> {
    const handlers = this.typed.get(event.type);
    if (handlers) {
      for (const h of handlers) {
        await h(event);
      }
    }
    for (const h of this.wildcard) {
      await h(event);
    }
  }

  clear(): void {
    this.typed.clear();
    this.wildcard.clear();
  }
}
