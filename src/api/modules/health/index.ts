import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { torrentServicePlugin } from "../torrents/plugin";

export const healthPlugin = new Elysia({ name: "tofu-health-api" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .get("/health", { idempotent: false, playback: true }, () => ({ ready: true }))
  .get("/diagnostics/connections", { administration: true, idempotent: false }, ({ torrents }) =>
    torrents.connectionDiagnostics()
  );
