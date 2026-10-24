import { currentInstanceConfig } from "./instance";

export const listen = {
  hostname: "127.0.0.1" as const,
  port: currentInstanceConfig().profile === "dev" ? 3030 : 3031,
};
