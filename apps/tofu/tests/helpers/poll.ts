export async function waitFor<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  timeout?: number
): Promise<T> {
  const deadline = Date.now() + (timeout ?? 15_000);
  let last: T | undefined;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Each observation must follow the previous one.
    last = await read();
    if (ready(last)) {
      return last;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for application state. Last value: ${JSON.stringify(last)}`);
}
