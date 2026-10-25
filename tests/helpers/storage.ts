import { Database } from "bun:sqlite";

export function changeStorageDevice(databasePath: string, id: string) {
  using db = new Database(databasePath);
  const message = "Not enough space in the torrent destination. Free space and retry.";
  // Keep the unrelated failure so startup cannot automatically recover this torrent.
  db.query(
    `UPDATE torrents SET value = json_set(value,
      '$.storageRoot.dev', json_extract(value, '$.storageRoot.dev') + 1,
      '$.detail.storageIssue', json(?), '$.detail.error', ?)
      WHERE id = ?`
  ).run(
    JSON.stringify({ detectedAt: Date.now(), kind: "no-space", message, paths: [] }),
    message,
    id
  );
}
