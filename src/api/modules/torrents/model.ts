import { t } from "elysia";

export const createTorrentSchema = t.Object({
  destinationId: t.Optional(t.String()),
  downloadPath: t.Optional(t.String()),
  paused: t.Boolean(),
  source: t.String({ maxLength: 65_536, minLength: 1 }),
  trackers: t.Optional(t.Array(t.String())),
});

export const uploadTorrentSchema = t.Object({
  destinationId: t.Optional(t.String()),
  downloadPath: t.Optional(t.String()),
  file: t.File({ maxSize: 8 * 1024 * 1024 }),
  paused: t.String(),
  trackers: t.Optional(t.String()),
});

export const trackersSchema = t.Object({
  urls: t.Array(t.String({ maxLength: 2048 }), { maxItems: 100 }),
});

export const removeTorrentSchema = t.Object({ deleteFiles: t.Boolean() });

export const filePrioritySchema = t.Object({
  priority: t.Union([t.Literal("skip"), t.Literal("normal"), t.Literal("high")]),
});

export const addPeerSchema = t.Object({ peer: t.String({ maxLength: 255, minLength: 1 }) });

export const bulkActionSchema = t.Object({
  action: t.Union([t.Literal("pause"), t.Literal("resume")]),
  ids: t.Optional(t.Array(t.String(), { maxItems: 1000 })),
});
