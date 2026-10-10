/** Shutdown keeps its dependency order even when a plugin or service fails to release resources. */
export async function shutdownServices(
  operations: readonly (() => unknown | Promise<unknown>)[]
): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Stop producers before closing their engine and storage.
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Application shutdown failed");
  }
}
