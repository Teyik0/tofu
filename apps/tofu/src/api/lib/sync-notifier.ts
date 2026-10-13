import type { SyncNotifier, SyncSubscription } from "@teyik0/furin/sync";

// Furin shares a cursor subscription across browsers; presence is sufficient.
export class ObservedSyncNotifier implements SyncNotifier {
  readonly recovery = "self" as const;
  private readonly listeners = new Set<{ listener: (cursor: string) => void }>();
  private readonly observe?: (observed: boolean) => void | Promise<void>;
  private cursor: string | undefined;
  private transition = Promise.resolve();
  private activation: Promise<void> | null = null;

  constructor(observe?: (observed: boolean) => void | Promise<void>) {
    this.observe = observe;
  }

  // biome-ignore lint/suspicious/useAwait: SyncNotifier requires a promise while local notification is synchronous.
  async publish(cursor: string) {
    if (this.cursor !== undefined && BigInt(cursor) <= BigInt(this.cursor)) {
      return;
    }
    this.cursor = cursor;
    for (const { listener } of this.listeners) {
      try {
        listener(cursor);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private changed(observed: boolean) {
    const transition = this.transition.then(() => this.observe?.(observed));
    this.transition = transition.catch(() => undefined);
    return transition;
  }

  async subscribe(listener: (cursor: string) => void): Promise<SyncSubscription> {
    const subscription = { listener };
    this.listeners.add(subscription);
    try {
      if (this.listeners.size === 1) {
        this.activation = this.changed(true);
      }
      await this.activation;
    } catch (error) {
      this.listeners.delete(subscription);
      if (this.listeners.size === 0) {
        this.activation = null;
        await this.changed(false).catch(() => undefined);
      }
      throw error;
    }
    let subscribed = true;
    return {
      unsubscribe: async () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        this.listeners.delete(subscription);
        if (this.listeners.size === 0) {
          this.activation = null;
          await this.changed(false);
        }
      },
    };
  }
}
