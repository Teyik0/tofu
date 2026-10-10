import { defineRoute } from "@teyik0/furin";
import { PluginGroup } from "../../components/plugins/plugin-group";
import { route as plugins } from "./_route";

export const route = defineRoute()
  .config({ layout: plugins, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Integration plugins — Tofu" }] }))
  .page(({ initialAutomation }) => (
    <PluginGroup
      ids={["anilist"]}
      plugins={initialAutomation.plugins}
      title="Account integrations"
    />
  ));
