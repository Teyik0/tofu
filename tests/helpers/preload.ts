import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { instance } from "../../src/api/lib/instance";
import { ServerCatalog } from "../../src/native/catalog";
import { nativeControl } from "../../src/native/control";
import { RemoteThreads } from "../../src/native/remote-threads";
import type { RemoteServerFixture } from "./app";

const [, , testPort, directory] = process.argv;
if (!directory) {
  throw new Error("Application fixtures require a temporary directory");
}
mkdirSync(join(directory, "state"), { recursive: true });
Object.assign(instance, {
  dataDir: join(directory, "state"),
  defaultDownloadPath: join(directory, "downloads"),
  desktop: false,
  logDirectory: join(directory, "state", "logs"),
  port: Number(testPort),
});

const remoteServers = process.env.TOFU_TEST_REMOTE_SERVERS;

if (remoteServers) {
  const fixtures = JSON.parse(remoteServers) as RemoteServerFixture[];
  const catalog = new ServerCatalog(join(instance.dataDir, "native"));

  catalog.value.servers.push(...fixtures.map((fixture) => fixture.server));

  nativeControl.tofuNativeThreads = new RemoteThreads({
    catalog,
    memory: new Map(fixtures.map((fixture) => [fixture.server.serverId, fixture.token])),
    service: "tofu-integration",
  });

  process.on("message", async (command: { type: string; serverId: string; origins?: string[] }) => {
    if (command.type !== "remote-catalog") {
      return;
    }
    await nativeControl.tofuNativeThreads?.stop(command.serverId);
    const server = catalog.value.servers.find(
      (candidate) => candidate.serverId === command.serverId
    );
    if (server && command.origins) {
      server.origins = command.origins;
      nativeControl.tofuNativeThreads?.start(command.serverId);
    } else {
      catalog.value.servers = catalog.value.servers.filter(
        (candidate) => candidate.serverId !== command.serverId
      );
    }
    process.send?.({ changed: command.serverId });
  });
}

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
  const paths: Record<string, string> = {
    "anilist.co": "/anilist",
    "api.github.com": "/github",
    "api.typesafe.ai": "/jev",
    "c411.org": "/c411",
    "graphql.anilist.co": "/anilist",
    "nyaa.si": "/nyaa",
    "release-assets.githubusercontent.com": "/github-assets",
  };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = paths[url.hostname];
      if (path) {
        const target = new URL(provider);
        target.pathname =
          path === "/github" || path === "/github-assets" ? `${path}${url.pathname}` : path;
        target.search = url.search;
        return await originalFetch(new Request(target, request));
      }
      return await originalFetch(request);
    },
    { preconnect: originalFetch.preconnect }
  );
}
