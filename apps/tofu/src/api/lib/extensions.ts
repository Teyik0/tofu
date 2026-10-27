// biome-ignore-all lint/performance/noBarrelFile: Preserve upstream host module paths for shared workspace implementations.
import { AniList } from "@tofu/anilist/server/service";
import { Context } from "effect";
import { sync } from "../../sync";
import { ReleaseAutomation } from "../modules/automation/integration";
import { Automation } from "../modules/automation/service";
import { Discovery } from "../modules/discovery/service";
import { Plugins } from "../modules/plugins/service";
import { TorrentClient } from "../modules/torrents/layer";
import { createApplicationPluginHost } from "../plugin-host";
import { instance } from "./instance";
import { services } from "./services-runtime";

const application = {
  anilist: Context.get(services, AniList),
  automation: Context.get(services, Automation),
  discovery: Context.get(services, Discovery),
  engine: Context.get(services, TorrentClient),
  instance,
  platform: { kind: "server" as const },
  plugins: Context.get(services, Plugins),
  releaseAutomation: Context.get(services, ReleaseAutomation),
  sync,
};
export type CoreApplication = typeof application;
export const pluginHost = createApplicationPluginHost(application);
export { closePluginHost, createApplicationPluginHost } from "../plugin-host";
