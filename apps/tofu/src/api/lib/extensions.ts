import type { AniListApiDependencies } from "@tofu/anilist/api";
import { sync } from "../../sync";
import type { EnginePort } from "../../types";
import { anilist } from "../modules/anilist/plugin";
import { automation } from "../modules/automation/index";
import { releaseAutomation } from "../modules/automation/plugin";
import { discovery } from "../modules/discovery/plugin";
import { plugins } from "../modules/plugins/plugin";
import { engine } from "../modules/torrents/plugin";
import { createApplicationPluginHost } from "../plugin-host";
import { instance } from "./database-plugin";
import { resources, runtime } from "./runtime";

const application = {
  anilist,
  automation,
  discovery,
  engine,
  instance,
  get platform() {
    return runtime.current;
  },
  plugins,
  releaseAutomation,
  sync,
};
export type CoreApplication = Omit<typeof application, "engine" | "sync"> & {
  engine: EnginePort;
  sync: AniListApiDependencies["sync"];
};
export const pluginHost = createApplicationPluginHost(application);
resources.defer(async () => {
  const { closePluginHost } = await import("../plugin-host");
  await closePluginHost(engine);
});

// biome-ignore lint/performance/noBarrelFile: Public host lifecycle helpers can be tested without starting singleton services.
export { closePluginHost, createApplicationPluginHost } from "../plugin-host";
