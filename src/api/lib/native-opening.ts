import type { Utils } from "electrobun/main";
import { problem } from "elysia";

/** Opens a URL in the host's browser; a refusal is returned as a typed problem. */
export function openExternalUrl(shell: typeof Utils, url: string, errorMessage: string) {
  let opened: boolean;
  try {
    opened = shell.openExternal(url);
  } catch {
    opened = false;
  }
  return opened ? null : problem(502, { detail: errorMessage });
}
