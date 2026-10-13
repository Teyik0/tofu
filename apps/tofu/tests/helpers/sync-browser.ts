export async function openSyncBrowser(origin: string) {
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let cursor: string | undefined;
  const url = new URL("/_furin/events", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(String(data)) as {
      channel: string;
      data: { cursor: string };
    };
    if (event.channel === "sync") {
      ({ cursor } = event.data);
      ready.resolve();
    }
  });
  socket.addEventListener("error", () => {
    ready.reject(new Error("The browser sync connection failed"));
  });
  socket.addEventListener("close", () => {
    ready.reject(new Error("The browser sync connection closed before becoming ready"));
    closed.resolve();
  });
  const readyDeadline = setTimeout(
    () =>
      ready.reject(new Error("The browser sync connection did not become ready within 10 seconds")),
    10_000
  );
  try {
    await ready.promise;
  } catch (error) {
    socket.close();
    throw error;
  } finally {
    clearTimeout(readyDeadline);
  }
  return {
    async close() {
      const closeDeadline = setTimeout(
        () =>
          closed.reject(new Error("The browser sync connection did not close within 10 seconds")),
        10_000
      );
      socket.close();
      try {
        await closed.promise;
      } finally {
        clearTimeout(closeDeadline);
      }
    },
    get cursor() {
      return cursor;
    },
  };
}
