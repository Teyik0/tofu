import type { InferOutput } from "valibot";
import {
  boolean,
  maxLength,
  minLength,
  nullable,
  object,
  optional,
  picklist,
  pipe,
  string,
} from "valibot";

export const destinationIconNames = [
  "folder",
  "film",
  "tv",
  "music",
  "book",
  "gamepad",
  "code",
  "archive",
  "star",
  "heart",
  "cloud",
  "flame",
] as const;

export const createDestinationSchema = object({
  autoAddTorrentFiles: optional(boolean()),
  deleteTorrentFileAfterAdd: optional(nullable(boolean())),
  downloadPath: pipe(string(), minLength(1), maxLength(4096)),
  icon: optional(picklist(destinationIconNames)),
  name: pipe(string(), minLength(1), maxLength(80)),
  pinned: optional(boolean()),
});

export const updateDestinationSchema = object({
  autoAddTorrentFiles: optional(boolean()),
  deleteTorrentFileAfterAdd: optional(nullable(boolean())),
  downloadPath: pipe(string(), minLength(1), maxLength(4096)),
  icon: optional(picklist(destinationIconNames)),
  moveFiles: optional(boolean()),
  name: pipe(string(), minLength(1), maxLength(80)),
  pinned: optional(boolean()),
});

export const destinationPresentationSchema = object({
  icon: optional(picklist(destinationIconNames)),
  pinned: optional(boolean()),
});

/** A thread placed beneath an owner-created storage root, by root ID and relative folder. */
export const destinationWithinRootSchema = object({
  folder: pipe(string(), maxLength(1024)),
  id: optional(string()),
  moveFiles: optional(boolean()),
  name: pipe(string(), minLength(1), maxLength(80)),
  rootId: string(),
});

export const storageRootSchema = object({
  name: pipe(string(), minLength(1), maxLength(80)),
  path: pipe(string(), minLength(1), maxLength(4096)),
});

export type DestinationIconName = (typeof destinationIconNames)[number];

export interface Destination {
  /** New .torrent files in the folder since this time are added automatically; null disables it. */
  autoAddTorrentFilesSince: number | null;
  /** Overrides the global setting for this thread; null follows the global setting. */
  deleteTorrentFileAfterAdd: boolean | null;
  downloadPath: string;
  icon: DestinationIconName;
  id: string;
  name: string;
  pinned: boolean;
}

export type DestinationInput = InferOutput<typeof updateDestinationSchema>;

export type DestinationPresentation = InferOutput<typeof destinationPresentationSchema>;
