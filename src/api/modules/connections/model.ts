import {
  array,
  boolean,
  type InferOutput,
  integer,
  ipv4,
  ipv6,
  literal,
  maxLength,
  maxValue,
  minValue,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";

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
