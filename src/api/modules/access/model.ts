import type { InferOutput } from "valibot";
import {
  array,
  boolean,
  integer,
  ipv4,
  ipv6,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
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

export const reconnectionSchema = object({ origin: pipe(string(), minLength(1), maxLength(256)) });
export const reconnectionClaimSchema = object({
  browserSecret: pipe(string(), minLength(43), maxLength(43)),
  label,
  secret: pipe(string(), minLength(43), maxLength(43)),
});
export const reconnectionCompleteSchema = object({
  browserSecret: pipe(string(), minLength(43), maxLength(43)),
  id: pipe(string(), minLength(36), maxLength(36)),
});
export const reconnectionDecisionSchema = object({
  approve: boolean(),
  code: pipe(string(), maxLength(9)),
});

/**
 * A change to one exposure, named by `transport`. Exposures are independent: turning one off
 * keeps the others. Local network fields change only with the local network exposure.
 */
export const connectionsUpdateSchema = object({
  enabled: boolean(),
  lanHostnames: optional(pipe(array(pipe(string(), maxLength(253))), maxLength(8))),
  /** Public local network HTTPS port; distinct from Tofu's own loopback port. */
  lanPort: optional(pipe(number(), integer(), minValue(1), maxValue(65_535))),
  proxyOrigin: optional(nullable(pipe(string(), maxLength(2048)))),
  tailscaleMode: optional(union([literal("embedded"), literal("system")])),
  transport: union([literal("tailscale"), literal("proxy"), literal("lan")]),
  trustedProxies: optional(
    pipe(array(union([pipe(string(), ipv4()), pipe(string(), ipv6())])), maxLength(16))
  ),
});

export type ConnectionsUpdate = InferOutput<typeof connectionsUpdateSchema>;
