import { Effect } from "effect";
import type { Utils } from "electrobun/main";
import { problem } from "elysia";

/** Opens a URL in the host's browser; a refusal is returned as a typed problem. */
export function openExternalUrl(shell: typeof Utils, url: string, errorMessage: string) {
  const opened = Effect.runSync(
    Effect.try(() => shell.openExternal(url)).pipe(Effect.orElseSucceed(() => false))
  );
  return opened ? null : problem(502, { detail: errorMessage });
}
