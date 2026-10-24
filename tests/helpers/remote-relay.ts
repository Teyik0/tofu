// DOM types omit Bun's authenticated WebSocket constructor overload.
const NativeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

export function remoteRelay(origin: string) {
  const control = {
    gate: null as {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    } | null,
    identityHold: null as ReturnType<typeof Promise.withResolvers<void>> | null,
  };
  const server = Bun.serve<{ cookie: string; upstream: WebSocket | null }>({
    async fetch(request, listener) {
      const url = new URL(request.url);
      if (url.pathname === "/_furin/events" && request.headers.get("upgrade") === "websocket") {
        if (listener.upgrade(request, {
          data: { cookie: request.headers.get("cookie") ?? "", upstream: null },
        })) {
          return;
        }
        return new Response("WebSocket upgrade failed", { status: 502 });
      }
      if (url.pathname === "/.well-known/tofu" && control.identityHold) {
        await control.identityHold.promise;
        return new Response(null, { status: 503 });
      }
      const gate = url.pathname === "/api/state" ? control.gate : null;
      const forwarded = new Request(new URL(`${url.pathname}${url.search}`, origin), request);
      forwarded.headers.delete("host");
      if (forwarded.headers.has("origin")) {
        forwarded.headers.set("origin", origin);
      }
      const response = await fetch(forwarded, { redirect: "error" });
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return response;
    },
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      close(socket) {
        socket.data.upstream?.close();
      },
      message(socket) {
        socket.close(1008, "Sync notifications are server-to-client only");
      },
      open(socket) {
        const url = new URL("/_furin/events", origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const upstream = new NativeWebSocket(url.href, {
          headers: { cookie: socket.data.cookie, origin },
        });
        socket.data.upstream = upstream;
        upstream.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            socket.send(event.data);
          }
        });
        upstream.addEventListener("close", () => socket.close());
        upstream.addEventListener("error", () => socket.close());
      },
    },
  });
  return {
    control,
    url: `http://127.0.0.1:${server.port}`,
    async [Symbol.asyncDispose]() {
      control.identityHold?.resolve();
      control.gate?.release.resolve();
      await server.stop(true);
    },
  };
}
