import { useRouter } from "@teyik0/furin/link";
import { useCallback } from "react";
import type { LibraryTorrent } from "../types";

type Router = ReturnType<typeof useRouter>;

export function isPreferencesPath(path: string) {
  return (
    path === "/options" ||
    path.startsWith("/options/") ||
    path === "/plugins" ||
    path.startsWith("/plugins/")
  );
}

export function destinationFromPath(path: string) {
  if (path === "/anilist") {
    return "anilist";
  }
  try {
    return path.startsWith("/thread/") ? decodeURIComponent(path.slice("/thread/".length)) : null;
  } catch {
    return null;
  }
}

/**
 * The torrent shown in the detail pane of a library page: the requested torrent when it belongs
 * to the page, otherwise the most recently added one, matching the library's default sort.
 */
export function selectedTorrentId(
  torrents: LibraryTorrent[],
  destinationId: string | null,
  requested: string | undefined
) {
  let latest: LibraryTorrent | undefined;
  for (const torrent of torrents) {
    if (destinationId !== null && torrent.destinationId !== destinationId) {
      continue;
    }
    if (torrent.id === requested) {
      return torrent.id;
    }
    if (!latest || torrent.addedAt > latest.addedAt) {
      latest = torrent;
    }
  }
  return latest?.id ?? null;
}

export function isSupersededNavigation(cause: unknown) {
  return Boolean(
    cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError"
  );
}

async function ignoreSuperseded(task: Promise<void>) {
  try {
    await task;
  } catch (cause) {
    if (!isSupersededNavigation(cause)) {
      throw cause;
    }
  }
}

export function useRefresh() {
  const router = useRouter();
  return useCallback(() => ignoreSuperseded(router.refresh()), [router.refresh]);
}

/** Opens a library page with `torrent` selected, or with its default selection when undefined. */
export function showTorrent(
  router: Router,
  destinationId: string | null,
  torrent: string | undefined
) {
  return ignoreSuperseded(
    destinationId === null
      ? router.navigate({ resetScroll: false, search: { torrent }, to: "/" })
      : router.navigate({
          params: { id: destinationId },
          resetScroll: false,
          search: { torrent },
          to: "/thread/:id",
        })
  );
}

export async function showDestination(
  router: Router,
  destinationId: string | null,
  activeDestination: string | null
) {
  if (destinationId && destinationId !== activeDestination) {
    await showTorrent(router, destinationId, undefined);
  } else {
    await ignoreSuperseded(router.refresh());
  }
}

export function backToWorkspace(router: Router, path: string) {
  const destination = destinationFromPath(path);
  return ignoreSuperseded(
    path.startsWith("/thread/") && destination !== null
      ? router.navigate({
          params: { id: destination },
          resetScroll: false,
          to: "/thread/:id",
        })
      : router.navigate({ resetScroll: false, to: path === "/anilist" ? "/anilist" : "/" })
  );
}
