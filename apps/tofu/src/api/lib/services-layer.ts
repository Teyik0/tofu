import { readAniListClient } from "@tofu/anilist/server/client";
import { AniListCapabilities } from "@tofu/anilist/server/dependencies";
import { findEpisodeSources } from "@tofu/plugins/availability";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { aniListLayer } from "../../../../../package/anilist/src/server/service";
import { accessLayer } from "../modules/access/layer";
import { ReleaseAutomation, releaseAutomationLayer } from "../modules/automation/integration";
import { Automation, automationLayer } from "../modules/automation/service";
import { openingsLayer } from "../modules/desktop/opening";
import { rootsLayer } from "../modules/destinations/roots";
import { Discovery, discoveryLayer } from "../modules/discovery/service";
import { librariesLayer } from "../modules/library-links/service";
import { playbackLinksLayer } from "../modules/media-links/service";
import { playbackLayer } from "../modules/playback/service";
import { Plugins, pluginsLayer } from "../modules/plugins/service";
import { TorrentFolderEngine, torrentFoldersLayer } from "../modules/torrents/folders";
import { TorrentClient, torrentClientLayer } from "../modules/torrents/layer";
import { updatesLayer } from "../modules/updates/service";
import { Database, databaseLayer as rawDatabaseLayer } from "./db";
import { instance } from "./instance";
import { instanceLayer } from "./instance-layer";
import { stateJournalsLayer } from "./state-journals";

// Only the main service graph owns the instance; the worker shares its application database.
const databaseLayer = rawDatabaseLayer.pipe(Layer.provideMerge(instanceLayer));
const plugins = pluginsLayer.pipe(Layer.provideMerge(databaseLayer));
const torrents = torrentClientLayer.pipe(Layer.provideMerge(databaseLayer));
const discovery = discoveryLayer.pipe(Layer.provideMerge(Layer.mergeAll(plugins, torrents)));
const automation = automationLayer.pipe(Layer.provideMerge(databaseLayer));
const releaseAutomation = releaseAutomationLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(automation, discovery))
);
const anilistCapabilities = Layer.effect(
  AniListCapabilities,
  Effect.gen(function* () {
    const engine = yield* TorrentClient;
    return {
      automation: yield* Automation,
      client: yield* Effect.tryPromise(() =>
        readAniListClient(instance.profile, process.env.TOFU_ANILIST_CLIENT_ID, process.execPath)
      ),
      db: yield* Database,
      discovery: yield* Discovery,
      endpoint: "https://graphql.anilist.co",
      engine,
      episodeSources: (queries) => findEpisodeSources(engine, queries),
      now: Date.now,
      plugins: yield* Plugins,
      releaseAutomation: yield* ReleaseAutomation,
      tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
    };
  })
).pipe(Layer.provideMerge(releaseAutomation));
const anilist = aniListLayer.pipe(Layer.provideMerge(anilistCapabilities));
const access = accessLayer.pipe(Layer.provideMerge(databaseLayer));

export const servicesLayer = Layer.mergeAll(
  anilist,
  access,
  updatesLayer,
  openingsLayer,
  playbackLayer.pipe(Layer.provide(databaseLayer)),
  librariesLayer.pipe(Layer.provideMerge(access)),
  playbackLinksLayer.pipe(Layer.provideMerge(databaseLayer)),
  rootsLayer.pipe(Layer.provideMerge(torrents)),
  torrentFoldersLayer.pipe(
    Layer.provide(Layer.effect(TorrentFolderEngine, TorrentClient)),
    Layer.provideMerge(torrents)
  ),
  stateJournalsLayer.pipe(Layer.provide(torrents))
).pipe(Layer.provide(FetchHttpClient.layer));
