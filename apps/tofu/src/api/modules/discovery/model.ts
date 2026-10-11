import { array, boolean, literal, maxLength, object, optional, pipe, string, union } from "valibot";
import { source } from "../automation/model";

export const discoverySchema = object({
  query: pipe(string(), maxLength(1000)),
  sources: optional(
    pipe(array(union([literal("nyaa"), literal("tsundere"), literal("c411")])), maxLength(3))
  ),
});

export const addReleaseSchema = object({
  destinationId: string(),
  id: pipe(string(), maxLength(4096)),
  paused: boolean(),
  sourceId: source,
});
