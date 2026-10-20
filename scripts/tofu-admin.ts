import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ElysiaStatus } from "elysia";
import { openDatabase } from "../src/api/lib/db";
import { acquireInstance, currentInstanceConfig } from "../src/api/lib/instance";
import { Devices } from "../src/api/modules/access/devices";
import { Invitations } from "../src/api/modules/access/invitations";
import { AccessService } from "../src/api/modules/access/service";
import { ConnectionsService } from "../src/api/modules/connections/service";
import { StorageRoots } from "../src/api/modules/destinations/roots";
import {
  anilistState,
  authorizedDevices,
  automationPlugins,
  deviceSessions,
  linkedServers,
  mediaLinks,
  pairingInvitations,
  playbackPositions,
  playbackSequences,
  serverIdentity,
} from "../src/db/schema";

const [action, ...args] = Bun.argv.slice(2);
const config = currentInstanceConfig();
const lease = await acquireInstance(config);
try {
  const db = await openDatabase(config.dataDir);
  try {
    const connections = new ConnectionsService({
      dataDir: config.dataDir,
      db,
      defaultLanPort: config.profile === "dev" ? 3442 : 3443,
      defaultPort: config.profile === "dev" ? 3030 : 3031,
      fixedPort: null,
      now: Date.now,
    });
    const access = new AccessService({
      db,
      headless: () => true,
      now: Date.now,
      policy: () => connections.policy(),
    });
    const invitations = new Invitations({ access, db, now: Date.now });
    const devices = new Devices({ access, db, now: Date.now });
    const owner = { kind: "owner", origin: "http://127.0.0.1", principal: "local-window" } as const;
    let result: unknown;
    if (action === "invite") {
      const role = args[0] ?? "playback";
      if (!["playback", "management", "administration"].includes(role)) {
        throw new Error("Role must be playback, management or administration");
      }
      result = invitations.create(owner, {
        canDeleteFiles: args.includes("--delete-files"),
        expiresInMinutes: 10,
        label: "Recovery invitation",
        role: role as "playback" | "management" | "administration",
      });
    } else if (action === "devices") {
      result = devices.list();
    } else if (action === "revoke" && args[0]) {
      result = devices.revoke(owner, args[0]);
    } else if (action === "revoke-all") {
      // Ends every remote device and pending invitation; the owner keeps local access.
      result = devices.revokeAll();
    } else if (action === "disable-remote") {
      result = connections.disable();
    } else if (action === "clone-identity" && args.includes("--confirm-clone")) {
      const previous = access.identity();
      connections.disable();
      db.transaction((tx) => {
        tx.delete(deviceSessions).run();
        tx.delete(authorizedDevices).run();
        tx.delete(pairingInvitations).run();
        tx.delete(mediaLinks).run();
        tx.delete(linkedServers).run();
        tx.delete(playbackPositions).run();
        tx.delete(playbackSequences).run();
        // A clone starts without the original person's provider accounts or pending AniList writes.
        tx.delete(automationPlugins).run();
        tx.delete(anilistState).run();
        tx.update(serverIdentity)
          .set({
            createdAt: Date.now(),
            identityEpoch: previous.identityEpoch + 1,
            serverId: crypto.randomUUID(),
          })
          .where(eq(serverIdentity.key, "server"))
          .run();
      });
      const current = connections.config();
      connections.save({
        ...current,
        tailscale: { ...current.tailscale, origin: null, serveOwned: false },
      });
      await Promise.all(
        ["tailscale", "tls", "native"].map((folder) =>
          rm(join(config.dataDir, folder), { force: true, recursive: true })
        )
      );
      result = {
        cloned: true,
        detail:
          "New identity created. Pair devices, enroll the private network, create certificates and connect provider accounts again. Review storage paths before starting the clone.",
        serverId: access.identity().serverId,
      };
    } else if (action === "root" && args[0] && args[1]) {
      const roots = new StorageRoots({ db, defaultPath: () => config.downloadPath, now: Date.now });
      result = await roots.add(args[0], args[1]);
    } else {
      throw new Error(
        "Usage: TOFU_DATA_DIR=<directory> bun scripts/tofu-admin.ts invite [playback|management|administration] [--delete-files] | devices | revoke <device-id> | revoke-all | disable-remote | root <name> <absolute-path> | clone-identity --confirm-clone. Stop Tofu first. Clone resets Tofu credentials, provider accounts and network identities in this copied data directory."
      );
    }
    if (result instanceof ElysiaStatus) {
      console.error(result.response.detail);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    db.$client.close(true);
  }
} finally {
  await lease.close();
}
