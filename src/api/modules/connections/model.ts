import {
  array,
  boolean,
  type InferOutput,
  ipv4,
  ipv6,
  literal,
  maxLength,
  nullable,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";

export const connectionsUpdateSchema = object({
  enabled: boolean(),
  lanHostnames: optional(pipe(array(pipe(string(), maxLength(253))), maxLength(8))),
  proxyOrigin: optional(nullable(pipe(string(), maxLength(2048)))),
  tailscaleMode: optional(union([literal("embedded"), literal("system")])),
  transport: union([literal("tailscale"), literal("proxy"), literal("lan")]),
  trustedProxies: optional(
    pipe(array(union([pipe(string(), ipv4()), pipe(string(), ipv6())])), maxLength(16))
  ),
});

export type ConnectionsUpdate = InferOutput<typeof connectionsUpdateSchema>;
