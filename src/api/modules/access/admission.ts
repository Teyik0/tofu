/** A TCP peer on this computer; never inferred from headers. */
export const LOOPBACK_PEER =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Exact anonymous allowlist; everything else requires an authenticated caller. */
export function isPublicRequest(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD") {
    return ["/.well-known/tofu", "/pair", "/signed-out", "/favicon.ico"].includes(pathname);
  }
  return method === "POST" && pathname === "/api/auth/pair";
}

/** Endpoints a linked server may call: availability and file-scoped playback links only. */
export const LINK_PATHS = new Set([
  "/api/session",
  "/api/auth/logout",
  "/api/library/availability",
  "/api/media-links",
  "/api/media-links/revoke",
]);

/** Endpoints a desktop client's native credential may call; it never reaches pages or media. */
export const NATIVE_PATHS = new Set([
  "/api/session",
  "/api/auth/window-sessions",
  "/api/auth/logout",
  "/api/anilist/oauth/remote-callback",
]);

/** Session cookie of one server; names are scoped because cookies ignore ports. */
export function cookieName(serverId: string, secure: boolean) {
  const suffix = serverId.replaceAll("-", "").slice(0, 16);
  // Browsers reject the __Host- prefix without HTTPS; plain loopback HTTP uses a scoped name.
  return secure ? `__Host-tofu-${suffix}` : `tofu-${suffix}`;
}

export function readCookie(header: string | null, name: string) {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
}
