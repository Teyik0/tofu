import { Context } from "effect";
import { Elysia } from "elysia";
import { services } from "../../lib/services-runtime";
import { discoveryServicePlugin } from "../discovery/plugin";
import { pluginRegistryPlugin } from "../plugins/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { automationPlugin } from ".";
import { ReleaseAutomation } from "./integration";

export const releaseAutomationPlugin = new Elysia({ name: "tofu-release-automation-integration" })
  .use(automationPlugin)
  .use(discoveryServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .decorate("releaseAutomation", Context.get(services, ReleaseAutomation));
