import "@teyik0/furin/server-only";
import { join } from "node:path";
import { Elysia } from "elysia";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { EmbeddedTailscale } from "./embedded";
import { ConnectionsService } from "./service";

export const connectionsServicePlugin = new Elysia({ name: "tofu-connections-service" })
  .use(databasePlugin)
  .decorate((dependencies) => {
    const embeddedTailscale = new EmbeddedTailscale(
      join(instance.dataDir, "tailscale"),
      join(instance.dataDir, "tls")
    );
    const defaultPort = instance.profile === "dev" ? 3030 : 3031;
    const connections = new ConnectionsService({
      dataDir: instance.dataDir,
      db: dependencies.db,
      defaultLanPort: instance.profile === "dev" ? 3442 : 3443,
      defaultPort: process.env.TOFU_PORT === undefined ? defaultPort : instance.port,
      embeddedTailscale,
      fixedPort: instance.desktop ? null : instance.port,
      now: Date.now,
    });
    dependencies.resources.defer(connections.close.bind(connections));
    return { ...dependencies, connections, embeddedTailscale };
  });
