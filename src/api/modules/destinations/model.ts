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
import { destinationIconNames } from "../../../types";

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
