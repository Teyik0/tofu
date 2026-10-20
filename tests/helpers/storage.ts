import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/api/lib/db";
import type { StorageIdentity, StoredFileIdentity } from "../../src/api/modules/torrents/storage";
import { torrentRecords } from "../../src/db/schema";
import type { TorrentDetail } from "../../src/types";
import { expectDefined } from "./problem";

export async function changeStoredStorageDevice(
  directory: string,
  id: string,
  options: { blocked: boolean; mtimeMs?: number }
) {
  const db = await openDatabase(directory);
  try {
    const row = db.select().from(torrentRecords).where(eq(torrentRecords.id, id)).get();
    expectDefined(row);
    const saved: {
      detail: TorrentDetail;
      storageRoot: StorageIdentity;
      storageFiles: StoredFileIdentity[];
    } = JSON.parse(row.value);
    saved.storageRoot.dev += 1;
    for (const file of saved.storageFiles) {
      file.dev += 1;
      if (options.mtimeMs !== undefined) {
        file.mtimeMs = options.mtimeMs;
      }
    }
    if (options.blocked) {
      saved.detail.storageIssue = {
        detectedAt: Date.now(),
        kind: "storage-unavailable",
        message: "The torrent destination is unavailable.",
        paths: saved.detail.files.map((file) => file.path),
      };
      saved.detail.error = saved.detail.storageIssue.message;
      saved.detail.downloaded = null;
      saved.detail.progress = null;
      for (const file of saved.detail.files) {
        file.downloaded = null;
        file.progress = null;
      }
    }
    db.update(torrentRecords)
      .set({ value: JSON.stringify(saved) })
      .where(eq(torrentRecords.id, id))
      .run();
  } finally {
    db.$client.close(true);
  }
}
