import { boolean, maxLength, minLength, object, optional, picklist, pipe, string } from "valibot";
import { destinationIconNames } from "../../../types";

export const createDestinationSchema = object({
  downloadPath: pipe(string(), minLength(1), maxLength(4096)),
  icon: optional(picklist(destinationIconNames)),
  name: pipe(string(), minLength(1), maxLength(80)),
  pinned: optional(boolean()),
});

export const updateDestinationSchema = object({
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
