import type { DesktopCapabilities } from "@teyik0/furin-electrobun/host";
import { problem } from "elysia";

/** Opens a URL in the host's browser; a refusal is returned as a typed problem. */
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
  return opened ? null : problem(502, { detail: errorMessage });
}
