import { Elysia } from "elysia";
import { discoveryServicePlugin } from "../discovery/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { automationPlugin } from ".";
import { ReleaseAutomationService } from "./integration";

export const releaseAutomationPlugin = new Elysia({ name: "tofu-release-automation-integration" })
  .use(automationPlugin)
  .use(discoveryServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .use((app) =>
    app.decorate((dependencies) => {
      const releaseAutomation = new ReleaseAutomationService({
        automation: dependencies.automation,
        discovery: dependencies.discovery,
        engine: dependencies.torrents,
        now: Date.now,
        plugins: dependencies.plugins,
      });

      app.onStart(releaseAutomation.start.bind(releaseAutomation));

      return { ...dependencies, releaseAutomation };
    })
  );
