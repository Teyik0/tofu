export type Disposer = () => void | Promise<void>;

export interface PluginScope {
  dispose: () => Promise<void>;
  onDispose: (disposer: Disposer) => void;
  readonly signal: AbortSignal;
}

export function createPluginScope(): PluginScope {
  const controller = new AbortController();
  const disposers: Disposer[] = [];
  let disposal: Promise<void> | undefined;
  return {
    dispose() {
      if (disposal) {
        return disposal;
      }
      controller.abort();
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        for (const disposer of disposers.toReversed()) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: Dispose dependent resources in reverse registration order.
            await disposer();
          } catch (error) {
            errors.push(error);
          }
        }
        disposers.length = 0;
        if (errors.length > 0) {
          throw new AggregateError(errors, "Plugin disposal failed");
        }
      });
      return disposal;
    },
    onDispose(disposer) {
      if (controller.signal.aborted) {
        throw new Error("The plugin scope has already been disposed");
      }
      disposers.push(disposer);
    },
    signal: controller.signal,
  };
}
