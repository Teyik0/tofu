import { existsSync } from "node:fs";

// Loaded only by test subprocesses. Windows uses this file to request graceful shutdown.
const shutdownPath = process.env.TOFU_TEST_SHUTDOWN;
if (shutdownPath) {
  const timer = setInterval(() => {
    if (existsSync(shutdownPath) && process.listenerCount("SIGTERM") > 0) {
      clearInterval(timer);
      process.emit("SIGTERM");
    }
  }, 50);
  timer.unref();
}

// Redirect provider HTTP traffic to the local fixture without replacing application services.
const provider = process.env.TOFU_TEST_PROVIDER;
if (provider) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (["graphql.anilist.co", "anilist.co", "nyaa.si"].includes(url.hostname)) {
        const target = new URL(provider);
        target.pathname = url.hostname === "nyaa.si" ? "/nyaa" : "/anilist";
        target.search = url.search;
        return await originalFetch(new Request(target, request));
      }
      return await originalFetch(request);
    },
    { preconnect: originalFetch.preconnect }
  );
}
