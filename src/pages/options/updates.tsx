import { defineRoute } from "@teyik0/furin";
import { UpdatesPanel } from "../../components/updates";
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Updates — Tofu" }] }))
  .page(() => (
    <div className="settings-updates">
      <UpdatesPanel disabled={false} />
    </div>
  ));
