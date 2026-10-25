import { Layer } from "effect";
import { accessLayer } from "../modules/access/layer";
import { aniListLayer } from "../modules/anilist/service";
import { releaseAutomationLayer } from "../modules/automation/integration";
import { automationLayer } from "../modules/automation/service";
import { openingsLayer } from "../modules/desktop/opening";
import { rootsLayer } from "../modules/destinations/roots";
import { discoveryLayer } from "../modules/discovery/service";
import { jevLayer } from "../modules/jev/service";
import { librariesLayer } from "../modules/library-links/service";
import { playbackLinksLayer } from "../modules/media-links/service";
import { playbackLayer } from "../modules/playback/service";
import { pluginsLayer } from "../modules/plugins/service";
import { TorrentFolderEngine, torrentFoldersLayer } from "../modules/torrents/folders";
import { TorrentClient, torrentClientLayer } from "../modules/torrents/layer";
import { updatesLayer } from "../modules/updates/service";
import { databaseLayer as rawDatabaseLayer } from "./database-layer";
import { instanceLayer } from "./instance-layer";
import { stateJournalsLayer } from "./state-journals";

// Only the main service graph owns the instance; the worker shares its application database.
const databaseLayer = rawDatabaseLayer.pipe(Layer.provideMerge(instanceLayer));
const plugins = pluginsLayer.pipe(Layer.provideMerge(databaseLayer));
const jev = jevLayer.pipe(Layer.provideMerge(plugins));
const torrents = torrentClientLayer.pipe(Layer.provideMerge(databaseLayer));
const discovery = discoveryLayer.pipe(Layer.provideMerge(Layer.mergeAll(jev, torrents)));
const automation = automationLayer.pipe(Layer.provideMerge(jev));
const releaseAutomation = releaseAutomationLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(automation, discovery))
);
const anilist = aniListLayer.pipe(Layer.provideMerge(releaseAutomation));
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
);
