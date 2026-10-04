import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FurinSyncOptions } from "@teyik0/furin/sync";
import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite";

// WebTorrent updates originate outside HTTP mutations. Publish through the public
// adapter so Furin owns durable recovery and the existing browser event transport.
export async function createTofuSync(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const database = new Database(join(dataDir, "sync.sqlite"), { create: true });
  migrateSqliteSync(database);
  const options: FurinSyncOptions = {
    adapter: sqliteSyncAdapter({ database, namespace: "tofu" }),
    principal: () => "local",
  };
  return {
    close() {
      database.close();
    },
    options,
    async publish() {
      const reservation = await options.adapter.beginMutation({
        fingerprint: "live",
        key: crypto.randomUUID(),
        principal: "local",
      });
      if (reservation.kind === "execute") {
        const result = await options.adapter.completeMutation({
          invalidations: [{ kind: "path", path: "/library", type: "layout" }],
          lease: reservation.lease,
          response: { body: new Uint8Array(), headers: [], status: 204 },
        });
        if (result.kind !== "committed") {
          throw new Error("Furin Sync publication timed out");
        }
      }
    },
  };
}
