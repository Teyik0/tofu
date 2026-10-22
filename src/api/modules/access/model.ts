import type { InferOutput } from "valibot";
import {
  boolean,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";

const role = union([literal("playback"), literal("management"), literal("administration")]);
const label = pipe(string(), minLength(1), maxLength(64));

export const pairSchema = object({
  code: optional(pipe(string(), maxLength(32))),
  kind: union([literal("browser"), literal("desktop"), literal("server")]),
  label,
  nonce: pipe(string(), minLength(22), maxLength(64)),
  /** Describes the invitation without redeeming it. */
  preview: optional(boolean()),
  secret: optional(pipe(string(), maxLength(64))),
});

export const invitationSchema = object({
  canDeleteFiles: boolean(),
  expiresInMinutes: pipe(number(), integer(), minValue(5), maxValue(1440)),
  label,
  profileId: optional(pipe(string(), maxLength(64))),
  role,
});

export const deviceChangeSchema = object({
  canDeleteFiles: optional(boolean()),
  label: optional(label),
  profileId: optional(pipe(string(), maxLength(64))),
  role: optional(role),
});

export const serverNameSchema = object({ name: label });

export type DeviceRole = InferOutput<typeof role>;

/** server: another Tofu server using this one as a playback source for its own AniList. */
export type DeviceKind = InferOutput<typeof pairSchema>["kind"];

/**
 * browser: cookie of a browser device; native: desktop bearer credential; window: desktop WebView
 * cookie; link: bearer credential of a linked server.
 */
export type SessionKind = "browser" | "native" | "window" | "link";

export const sessionTransferSchema = object({
  secret: pipe(string(), minLength(43), maxLength(43)),
});
