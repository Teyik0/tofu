import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DeviceKind, DeviceRole, SessionKind } from "../api/modules/access/model";
import type { Destination } from "../api/modules/destinations/model";

export const torrentConfig = sqliteTable("config", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const torrentRecords = sqliteTable("torrents", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const torrentDestinations = sqliteTable("destinations", {
  autoAddTorrentFilesSince: integer(),
  deleteTorrentFileAfterAdd: integer({ mode: "boolean" }),
  downloadPath: text().notNull(),
  icon: text().$type<Destination["icon"]>().notNull().default("folder"),
  id: text().primaryKey(),
  name: text().notNull(),
  pinned: integer({ mode: "boolean" }).notNull().default(false),
});

export const watchedTorrentFiles = sqliteTable("watched_files", {
  changedAt: integer().notNull(),
  infoHash: text(),
  path: text().primaryKey(),
});

export const automationPlugins = sqliteTable("plugins", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationRules = sqliteTable("automations", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationDecisions = sqliteTable("decisions", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationJudgements = sqliteTable("judgements", {
  createdAt: integer().notNull(),
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationReleases = sqliteTable("releases", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationPreferences = sqliteTable("preferences", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const anilistState = sqliteTable("anilist", {
  id: text().primaryKey(),
  value: text().notNull(),
});

/** Stable identity of this server, independent of its addresses and display name. */
export const serverIdentity = sqliteTable("server_identity", {
  createdAt: integer().notNull(),
  identityEpoch: integer().notNull(),
  key: text().primaryKey(),
  name: text().notNull(),
  serverId: text().notNull(),
});

export const authorizedDevices = sqliteTable("devices", {
  canDeleteFiles: integer({ mode: "boolean" }).notNull(),
  createdAt: integer().notNull(),
  grantVersion: integer().notNull(),
  id: text().primaryKey(),
  invitationId: text(),
  /** "owner" or the issuing device ID. */
  issuer: text().notNull(),
  kind: text().$type<DeviceKind>().notNull(),
  label: text().notNull(),
  lastSeenAt: integer().notNull(),
  pairedAt: integer().notNull(),
  profileId: text().notNull(),
  redemptionNonceHash: text(),
  revokedAt: integer(),
  role: text().$type<DeviceRole>().notNull(),
});

export const deviceSessions = sqliteTable("device_sessions", {
  createdAt: integer().notNull(),
  deviceId: text().notNull(),
  expiresAt: integer().notNull(),
  id: text().primaryKey(),
  idleExpiresAt: integer().notNull(),
  kind: text().$type<SessionKind>().notNull(),
  lastSeenAt: integer().notNull(),
  tokenHash: text().notNull().unique(),
});

/** Short-lived browser handoffs; only the digest is persisted. */
export const sessionTransfers = sqliteTable("session_transfers", {
  expiresAt: integer().notNull(),
  grantVersion: integer().notNull(),
  origin: text().notNull(),
  sourceSessionId: text().notNull().unique(),
  tokenHash: text().primaryKey(),
});

export const pairingInvitations = sqliteTable("invitations", {
  canDeleteFiles: integer({ mode: "boolean" }).notNull(),
  codeHash: text().notNull().unique(),
  consumedAt: integer(),
  consumedBy: text(),
  createdAt: integer().notNull(),
  expiresAt: integer().notNull(),
  failedAttempts: integer().notNull().default(0),
  id: text().primaryKey(),
  issuer: text().notNull(),
  label: text().notNull(),
  profileId: text(),
  revokedAt: integer(),
  role: text().$type<DeviceRole>().notNull(),
  secretHash: text().notNull().unique(),
});

export const playbackPositions = sqliteTable(
  "playback_positions",
  {
    duration: real().notNull(),
    mediaKey: text().notNull(),
    position: real().notNull(),
    profileId: text().notNull(),
    sequence: integer().notNull(),
    sessionId: text().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.mediaKey] })]
);

/** Last accepted sequence for every playback session, including interleaved players. */
export const playbackSequences = sqliteTable(
  "playback_sequences",
  {
    mediaKey: text().notNull(),
    profileId: text().notNull(),
    sequence: integer().notNull(),
    sessionId: text().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.mediaKey, table.sessionId] })]
);

/** Host folders beneath which remote administrators may create destinations. Owner only. */
export const storageRoots = sqliteTable("storage_roots", {
  createdAt: integer().notNull(),
  id: text().primaryKey(),
  name: text().notNull(),
  path: text().notNull().unique(),
});

export const mediaLinks = sqliteTable("media_links", {
  createdAt: integer().notNull(),
  deviceId: text(),
  expiresAt: integer().notNull(),
  fileIndex: integer().notNull(),
  fileLength: integer().notNull(),
  fileName: text().notNull(),
  id: text().primaryKey(),
  revokedAt: integer(),
  tokenHash: text().notNull().unique(),
  torrentId: text().notNull(),
});

/** Remote access configuration: "active", "pending" (awaiting confirmation) and "last-good". */
export const connectionState = sqliteTable("connection_state", {
  key: text().primaryKey(),
  updatedAt: integer().notNull(),
  value: text().notNull(),
});

/**
 * Other Tofu servers this server uses as playback sources for its own AniList. The credential is a
 * host integration secret, like provider tokens: stored only in this data directory.
 */
export const linkedServers = sqliteTable("linked_servers", {
  createdAt: integer().notNull(),
  credential: text().notNull(),
  deviceId: text().notNull(),
  id: text().primaryKey(),
  lastCheckedAt: integer(),
  name: text().notNull(),
  origin: text().notNull(),
  serverId: text().notNull().unique(),
  state: text().$type<"active" | "revoked" | "identity-changed">().notNull(),
});

/** Durable receipts for torrent worker side effects, reconciled at startup. */
export const operationReceipts = sqliteTable("operation_receipts", {
  completedAt: integer(),
  createdAt: integer().notNull(),
  id: text().primaryKey(),
  kind: text().notNull(),
  result: text(),
  status: text().$type<"pending" | "done" | "failed">().notNull(),
  target: text().notNull(),
});

export const schema = {
  anilistState,
  authorizedDevices,
  automationDecisions,
  automationJudgements,
  automationPlugins,
  automationPreferences,
  automationReleases,
  automationRules,
  connectionState,
  deviceSessions,
  linkedServers,
  mediaLinks,
  operationReceipts,
  pairingInvitations,
  playbackPositions,
  playbackSequences,
  serverIdentity,
  sessionTransfers,
  storageRoots,
  torrentConfig,
  torrentDestinations,
  torrentRecords,
};
