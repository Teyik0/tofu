import { Context, Effect, Layer } from "effect";
import { version } from "../../../package.json";
import { Access, accessLayer } from "../modules/access/layer";
import { readAniListClient } from "../modules/anilist/client";
import { AniListService } from "../modules/anilist/service";
import { ReleaseAutomationService } from "../modules/automation/integration";
import { AutomationService } from "../modules/automation/service";
import { StorageRoots } from "../modules/destinations/roots";
import { DiscoveryService } from "../modules/discovery/service";
import { JevService } from "../modules/jev/service";
import { LinkedLibraries } from "../modules/library-links/service";
import { MediaLinks } from "../modules/media-links/service";
import { PluginsService, pluginEndpoints } from "../modules/plugins/service";
import { TorrentFolderEngine, torrentFoldersLayer } from "../modules/torrents/folders";
import { TorrentClient, torrentClientLayer } from "../modules/torrents/layer";
import { UpdatesService } from "../modules/updates/service";
import { Database, databaseLayer } from "./database-layer";
import { instance } from "./instance";
import { stateJournalsLayer } from "./state-journals";

export const Plugins = Context.Service<PluginsService>("tofu/plugins");
export const Jev = Context.Service<JevService>("tofu/jev");
export const Automation = Context.Service<AutomationService>("tofu/automation");
export const Discovery = Context.Service<DiscoveryService>("tofu/discovery");
export const ReleaseAutomation =
  Context.Service<ReleaseAutomationService>("tofu/release-automation");
export const AniList = Context.Service<AniListService>("tofu/anilist");
export const Updates = Context.Service<UpdatesService>("tofu/updates");
export const Libraries = Context.Service<LinkedLibraries>("tofu/linked-libraries");
export const PlaybackLinks = Context.Service<MediaLinks>("tofu/media-links");
export const Roots = Context.Service<StorageRoots>("tofu/storage-roots");

const pluginsLayer = Layer.effect(
  Plugins,
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.acquireRelease(
      Effect.sync(() => new PluginsService(db, { endpoints: pluginEndpoints, now: Date.now })),
      (service) => Effect.sync(() => service.close())
    );
  })
).pipe(Layer.provideMerge(databaseLayer));

const jevLayer = Layer.effect(
  Jev,
  Effect.gen(function* () {
    const db = yield* Database;
    const plugins = yield* Plugins;
    return yield* Effect.acquireRelease(
      Effect.sync(
        () => new JevService(db, { endpoint: pluginEndpoints.jev, now: Date.now, plugins })
      ),
      (service) => Effect.promise(() => service.close())
    );
  })
).pipe(Layer.provideMerge(pluginsLayer));

const torrentsLayer = torrentClientLayer.pipe(Layer.provideMerge(databaseLayer));

const discoveryLayer = Layer.effect(
  Discovery,
  Effect.gen(function* () {
    const db = yield* Database;
    const plugins = yield* Plugins;
    const jev = yield* Jev;
    const engine = yield* TorrentClient;
    return yield* Effect.acquireRelease(
      Effect.sync(
        () => new DiscoveryService(db, { endpoints: pluginEndpoints, engine, jev, plugins })
      ),
      (service) => Effect.promise(() => service.close())
    );
  })
).pipe(Layer.provideMerge(Layer.mergeAll(jevLayer, torrentsLayer)));

const automationLayer = Layer.effect(
  Automation,
  Effect.gen(function* () {
    const db = yield* Database;
    const jev = yield* Jev;
    return new AutomationService(db, { jev, now: Date.now });
  })
).pipe(Layer.provideMerge(jevLayer));

const releaseAutomationLayer = Layer.effect(
  ReleaseAutomation,
  Effect.gen(function* () {
    const automation = yield* Automation;
    const discovery = yield* Discovery;
    const engine = yield* TorrentClient;
    const plugins = yield* Plugins;
    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new ReleaseAutomationService({ automation, discovery, engine, now: Date.now, plugins })
      ),
      (service) => Effect.promise(() => service.close())
    );
  })
).pipe(Layer.provideMerge(Layer.mergeAll(automationLayer, discoveryLayer)));

const anilistLayer = Layer.effect(
  AniList,
  Effect.gen(function* () {
    const db = yield* Database;
    const automation = yield* Automation;
    const discovery = yield* Discovery;
    const engine = yield* TorrentClient;
    const jev = yield* Jev;
    const plugins = yield* Plugins;
    const releaseAutomation = yield* ReleaseAutomation;
    const client = yield* Effect.tryPromise(() =>
      readAniListClient(instance.profile, process.env.TOFU_ANILIST_CLIENT_ID, process.execPath)
    );
    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new AniListService(db, {
            automation,
            client,
            discovery,
            endpoint: "https://graphql.anilist.co",
            engine,
            jev,
            now: Date.now,
            plugins,
            releaseAutomation,
            tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
          })
      ),
      (service) => Effect.promise(() => service.close())
    );
  })
).pipe(Layer.provideMerge(releaseAutomationLayer));

const accessServicesLayer = accessLayer.pipe(Layer.provideMerge(databaseLayer));

const updatesLayer = Layer.effect(
  Updates,
  Effect.acquireRelease(
    Effect.tryPromise(() =>
      UpdatesService.open({
        apiOrigin: "https://api.github.com",
        arch: process.arch,
        dataDir: instance.dataDir,
        notify: () => undefined,
        platform: process.platform,
        version,
      })
    ),
    (service) => Effect.promise(() => service.close())
  )
);

const librariesLayer = Layer.effect(
  Libraries,
  Effect.gen(function* () {
    const db = yield* Database;
    const { access } = yield* Access;
    return new LinkedLibraries({ db, now: Date.now, serverId: () => access.identity().serverId });
  })
).pipe(Layer.provideMerge(accessServicesLayer));

const mediaLinksLayer = Layer.effect(
  PlaybackLinks,
  Effect.gen(function* () {
    const db = yield* Database;
    return new MediaLinks({ db, now: Date.now });
  })
).pipe(Layer.provideMerge(databaseLayer));

const rootsLayer = Layer.effect(
  Roots,
  Effect.gen(function* () {
    const db = yield* Database;
    const torrents = yield* TorrentClient;
    return new StorageRoots({
      db,
      defaultPath: () => torrents.settings.downloadPath,
      now: Date.now,
    });
  })
).pipe(Layer.provideMerge(torrentsLayer));

const foldersLayer = torrentFoldersLayer.pipe(
  Layer.provide(Layer.effect(TorrentFolderEngine, TorrentClient)),
  Layer.provideMerge(torrentsLayer)
);

export const servicesLayer = Layer.mergeAll(
  anilistLayer,
  accessServicesLayer,
  updatesLayer,
  librariesLayer,
  mediaLinksLayer,
  rootsLayer,
  foldersLayer,
  stateJournalsLayer.pipe(Layer.provide(torrentsLayer))
);
