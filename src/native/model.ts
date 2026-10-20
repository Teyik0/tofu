import {
  boolean,
  type InferOutput,
  literal,
  maxLength,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";

export const nativeServerActionSchema = object({
  action: union([
    literal("discover"),
    literal("pair"),
    literal("open"),
    literal("reconnect"),
    literal("disconnect"),
    literal("forget"),
    literal("save-server"),
    literal("hosting"),
  ]),
  address: optional(pipe(string(), maxLength(4096))),
  alias: optional(pipe(string(), maxLength(64))),
  code: optional(pipe(string(), maxLength(32))),
  id: optional(pipe(string(), maxLength(36))),
  label: optional(pipe(string(), maxLength(64))),
  origins: optional(pipe(string(), maxLength(8192))),
  temporary: optional(boolean()),
});

export type NativeServerAction = InferOutput<typeof nativeServerActionSchema>;
