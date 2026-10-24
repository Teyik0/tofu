import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createContext, Elysia, ElysiaStatus } from "elysia";
import { version } from "../../../../package.json";
import { instance } from "../../lib/instance";
import { lifecyclePlugin } from "../../lib/lifecycle-plugin";
import { TorrentFolders } from "./folders";
import { WorkerTorrentEngine } from "./worker-client";

const initialization = Effect.gen(function* () {
  const torrents = yield* Effect.acquireRelease(
    Effect.promise(() =>
      WorkerTorrentEngine.open({
        dataDir: instance.dataDir,
        downloadPath: instance.defaultDownloadPath,
        network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
      })
    ),
    (engine) => Effect.promise(() => engine.close())
  );
  torrents.mode = instance.desktop ? "desktop" : "server";

  const ready = yield* Effect.promise(async () => await torrents.assertReady());
  if (ready instanceof ElysiaStatus) {
    return yield* Effect.die(new Error(ready.response.detail));
  }

  const torrentFolders = yield* Effect.acquireRelease(
    Effect.sync(() => new TorrentFolders({ dataDir: instance.dataDir, engine: torrents })),
    (folders) => Effect.promise(() => folders.close())
  );
  return { torrentFolders, torrents };
});

const TorrentServices = Context.Service<Effect.Success<typeof initialization>>("tofu/torrents");
export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(lifecyclePlugin)
  .use(async (app) => {
    const { resources } = createContext(app).prototype;
    // Register before startup so shutdown also interrupts and awaits an in-flight acquisition.
    const torrentRuntime = resources.use(
      ManagedRuntime.make(Layer.effect(TorrentServices, initialization))
    );
    const services = await torrentRuntime.runPromise(TorrentServices);
    return app.decorate(services);
  });

await torrentServicePlugin.modules;
