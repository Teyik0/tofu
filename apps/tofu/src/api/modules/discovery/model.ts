import { array, boolean, maxLength, object, optional, pipe, string } from "valibot";
import { source } from "../automation/model";

export const discoverySchema = object({
  query: pipe(string(), maxLength(1000)),
  sources: optional(pipe(array(source), maxLength(32))),
});

export const addReleaseSchema = object({
  destinationId: string(),
  id: pipe(string(), maxLength(4096)),
  paused: boolean(),
  sourceId: source,
});
