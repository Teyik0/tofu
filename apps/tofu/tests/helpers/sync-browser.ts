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
  try {
    await ready.promise;
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    async close() {
      socket.close();
      await closed.promise;
    },
    get cursor() {
      return cursor;
    },
  };
}
