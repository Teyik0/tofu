import {
  array,
  boolean,
  check,
  file,
  forward,
  is,
  literal,
  maxLength,
  maxSize,
  minLength,
  nullable,
  object,
  optional,
  partialCheck,
  picklist,
  pipe,
  string,
  union,
} from "valibot";
import type { FormModalKind } from "../../../types";
import { updateDestinationSchema } from "../destinations/model";

export const trackersSchema = object({
  urls: pipe(array(pipe(string(), maxLength(2048))), maxLength(100)),
});

export const createTorrentSchema = object({
  destinationId: optional(string()),
  downloadPath: optional(string()),
  paused: boolean(),
  source: pipe(string(), minLength(1), maxLength(65_536)),
  trackers: optional(trackersSchema.entries.urls),
});

export const uploadTorrentSchema = object({
  destinationId: optional(string()),
  downloadPath: optional(string()),
  file: pipe(file(), maxSize(8_388_608)),
  paused: picklist(["true", "false"]),
  trackers: optional(
    pipe(
      string(),
      check(
        (value) => is(trackersSchema.entries.urls, value.split("\n")),
        "Enter at most 100 tracker URLs of at most 2048 characters"
      )
    )
  ),
});

export const removeTorrentSchema = object({ deleteFiles: boolean() });

export const filePrioritySchema = object({
  priority: union([literal("skip"), literal("normal"), literal("high")]),
});

export const addPeerSchema = object({
  peer: pipe(string(), minLength(1), maxLength(255)),
});

export const bulkActionSchema = object({
  action: union([literal("pause"), literal("resume")]),
  ids: optional(pipe(array(string()), maxLength(1000))),
});

export function modalFormSchema(kind: FormModalKind["type"]) {
  return pipe(
    object({
      destinationIcon: updateDestinationSchema.entries.icon.wrapped,
      destinationId: string(),
      file: nullable(uploadTorrentSchema.entries.file),
      moveFiles: boolean(),
      name: string(),
      path: string(),
      paused: boolean(),
      pinned: boolean(),
      removeFiles: boolean(),
      source: string(),
      trackers: string(),
    }),
    forward(
      partialCheck(
        [["source"], ["file"]],
        (input) => {
          if (kind === "add") {
            return (
              input.file !== null || is(createTorrentSchema.entries.source, input.source.trim())
            );
          }
          return kind !== "peer" || is(addPeerSchema.entries.peer, input.source.trim());
        },
        kind === "peer"
          ? "Enter a peer address"
          : "Choose a torrent file or enter a magnet link or URL"
      ),
      ["source"]
    ),
    forward(
      partialCheck(
        [["destinationId"], ["name"]],
        (input) =>
          !(kind === "destination" || (kind === "drop" && input.destinationId === "new")) ||
          is(updateDestinationSchema.entries.name, input.name),
        "Enter a tab name of at most 80 characters"
      ),
      ["name"]
    ),
    forward(
      partialCheck(
        [["destinationId"], ["path"]],
        (input) =>
          !(kind === "destination" || (kind === "drop" && input.destinationId === "new")) ||
          is(updateDestinationSchema.entries.downloadPath, input.path),
        "Enter a download folder of at most 4096 characters"
      ),
      ["path"]
    )
  );
}
