export function remoteRelay(origin: string) {
  const control = {
    gate: null as {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    } | null,
    identityHold: null as ReturnType<typeof Promise.withResolvers<void>> | null,
  };
  const server = Bun.serve({
    async fetch(request) {
      const url = new URL(request.url);
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
