import {
  type InferOutput,
  integer,
  maxLength,
  minValue,
  number,
  object,
  pipe,
  regex,
  string,
} from "valibot";

// A local file `<infohash>:<file index>:<length>`, or the same prefixed by a linked server ID.
export const mediaKeyParamsSchema = object({
  mediaKey: pipe(
    string(),
    maxLength(200),
    regex(/^(?:remote:[0-9a-f-]{36}:)?[0-9a-f]{40}:\d+:\d+$/)
  ),
});

export const positionSchema = object({
  duration: pipe(number(), minValue(0)),
  position: pipe(number(), minValue(0)),
  sequence: pipe(number(), integer(), minValue(0)),
  sessionId: pipe(string(), maxLength(64)),
});

export type PositionInput = InferOutput<typeof positionSchema>;
