import { defineRoute } from "@teyik0/furin";
import { PluginGroup } from "../../components/plugins/plugin-group";
import { route as plugins } from "./_route";

export const route = defineRoute()
  .config({ layout: plugins, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Torrent source plugins — Tofu" }] }))
  .page(({ initialAutomation }) => (
    <PluginGroup
      ids={["nyaa", "tsundere", "c411"]}
      plugins={initialAutomation.plugins}
      title="Torrent sources"
    />
  ));
