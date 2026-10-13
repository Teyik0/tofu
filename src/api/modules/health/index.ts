import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { torrentServicePlugin } from "../torrents/plugin";

export const healthPlugin = new Elysia({ name: "tofu-health-api" })
  .use(torrentServicePlugin)
  .use(furinSync(sync))
  .get("/health", { sync: false }, () => ({ ready: true }))
  .get("/diagnostics/connections", { sync: false }, ({ torrents }) =>
    torrents.connectionDiagnostics()
  );
