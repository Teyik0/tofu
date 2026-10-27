import { defineRoute } from "@teyik0/furin";
import { UpdatesPanel } from "../../../components/updates";

export const route = defineRoute("/options/updates")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Updates — Tofu" }] }))
  .page(() => (
    <div className="settings-updates">
      <UpdatesPanel disabled={false} />
    </div>
  ));
