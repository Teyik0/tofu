import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { HTTPError } from "elysia";
import type { Torrent } from "webtorrent";
import type { FileStats, TorrentStorageIssue } from "../../../types";
import { recordLog } from "../../lib/diagnostics";

export interface StorageIdentity {
  canonicalPath?: string;
  dev: number;
  ino: number;
}

export interface StoredFileIdentity extends StorageIdentity {
  complete: boolean;
  mtimeMs: number;
  path: string;
  size: number;
}

export function storageFileChanged(
  file: FileStats,
  stored: Stats,
  before: StoredFileIdentity | undefined
) {
  return (
    !stored.isFile() ||
    stored.size < (file.downloaded ?? 0) ||
    (file.progress === 1 && stored.size !== file.length) ||
    (before !== undefined &&
      (before.dev !== stored.dev ||
        before.ino !== stored.ino ||
        stored.size < before.size ||
        (before.complete && file.progress === 1 && before.mtimeMs !== stored.mtimeMs)))
  );
}

export function verifiedFileBytes(torrent: Torrent, file: Torrent["files"][number]) {
  let verified = 0;
  const end = file.offset + file.length;
  for (
    let index = Math.floor(file.offset / torrent.pieceLength);
    index < Math.ceil(end / torrent.pieceLength);
    index += 1
  ) {
    if (torrent.pieces[index] === null) {
      verified +=
        Math.min(end, (index + 1) * torrent.pieceLength) -
        Math.max(file.offset, index * torrent.pieceLength);
    }
  }
  return verified;
}

const storageErrorCode = /\b(EACCES|EPERM|ENOSPC|EDQUOT|ENOENT|ENODEV|EIO|EROFS)\b/;

export function storageFailure(
  cause: unknown,
  paths: string[],
  context?: {
    dataDir: string;
    torrentId?: string;
    savePath: string;
    expected?: StorageIdentity | null;
  }
): TorrentStorageIssue {
  if (context) {
    const { dataDir, ...fields } = context;
    recordLog({
      component: "storage",
      context: { ...fields, paths },
      dataDir,
      error: cause,
      level: "error",
      operation: "access",
    });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    cause instanceof Error && !(cause instanceof HTTPError) && "code" in cause
      ? String(cause.code)
      : message.match(storageErrorCode)?.[0];
  let kind: TorrentStorageIssue["kind"] = "io-error";
  let description = "Unable to access the torrent storage. Check the destination and retry.";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    kind = "permission-denied";
    description = "Permission denied or read-only torrent storage. Restore access and retry.";
  } else if (code === "ENOSPC" || code === "EDQUOT") {
    kind = "no-space";
    description = "Not enough space in the torrent destination. Free space and retry.";
  } else if (code === "ENOENT" || code === "ENODEV" || code === "EIO") {
    kind = "storage-unavailable";
    description =
      "The torrent destination is unavailable. Reconnect the original storage or locate the files.";
  } else if (cause instanceof HTTPError) {
    kind = "invalid-path";
    description = message;
  }
  return { detectedAt: Date.now(), kind, message: description, paths };
}

export async function storageRoot(path: string, expected: StorageIdentity | null) {
  const root = await stat(path);
  if (
    !root.isDirectory() ||
    (expected && (root.dev !== expected.dev || root.ino !== expected.ino))
  ) {
    throw Object.assign(new Error("The original torrent destination is unavailable"), {
      code: "ENODEV",
      expected,
      observed: { dev: root.dev, directory: root.isDirectory(), ino: root.ino },
      path,
    });
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: filesystem access modes are bit flags.
  await access(path, constants.R_OK | constants.X_OK);
  return {
    canonicalPath: await realpath(path),
    dev: root.dev,
    ino: root.ino,
  } satisfies StorageIdentity;
}
