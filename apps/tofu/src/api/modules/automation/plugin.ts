import { Elysia } from "elysia";
import { resources } from "../../lib/runtime";
import { discovery, discoveryServicePlugin } from "../discovery/plugin";
import { plugins } from "../plugins/plugin";
import { engine } from "../torrents/plugin";
import { automation, automationPlugin } from ".";
import { ReleaseAutomationService } from "./integration";

export const releaseAutomation = new ReleaseAutomationService({
  automation,
  discovery,
  engine,
  now: Date.now,
  plugins,
});
export const releaseAutomationPlugin = new Elysia({ name: "tofu-release-automation-integration" })
  .use(automationPlugin)
  .use(discoveryServicePlugin)
  .decorate("releaseAutomation", releaseAutomation);
resources.defer(releaseAutomation.close.bind(releaseAutomation));
releaseAutomationPlugin.setup(() => {
  void releaseAutomation.start().catch(console.error);
});
