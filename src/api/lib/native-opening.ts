import type { DesktopCapabilities } from "@teyik0/furin-electrobun/host";
import { HTTPError } from "elysia";

export function openExternalUrl(
  shell: DesktopCapabilities["shell"],
  url: string,
  errorMessage: string
) {
  let opened: boolean;
  try {
    opened = shell.openExternal(url);
  } catch {
    opened = false;
  }
  if (!opened) {
    throw new (HTTPError.id("BAD_GATEWAY", 502))(errorMessage);
  }
}
