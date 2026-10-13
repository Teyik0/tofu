import type { ServerInfo } from "../src/types";

export function nativeRequest(
  server: Pick<ServerInfo, "url" | "cookie">,
  path: string,
  init: RequestInit | undefined
) {
  const url = new URL(path, server.url);
  if (url.origin !== new URL(server.url).origin) {
    throw new Error("Native requests must use the instance origin");
  }
  const headers = new Headers(init?.headers);
  if (server.cookie) {
    headers.set("cookie", server.cookie);
  }
  return fetch(url, { ...init, headers, redirect: "error" });
}
