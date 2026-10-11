import { useEffect, useState } from "react";
import { request } from "../components/api";
import { errorMessage } from "../lib/errors";
import type { AniListEntry, AniListMedia, AniListReleases, FeedRelease } from "../types";

export function useAniListReleases(entry: AniListMedia | AniListEntry) {
  const { mediaId } = entry;
  const listed = "progress" in entry;
  const [result, setResult] = useState<AniListReleases | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchVersion, setSearchVersion] = useState(0);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const reload = () => {
    setLoading(true);
    setReleaseError(null);
    setSearchVersion((value) => value + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshing explicitly starts a new release search.
  useEffect(() => {
    const controller = new AbortController();
    void request<AniListReleases>(
      `/anilist/entries/${mediaId}/releases`,
      "POST",
      {},
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setResult(value);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setReleaseError(errorMessage(cause, "Unable to find releases"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [mediaId, searchVersion]);

  type ReleaseStatus = "searching" | "ready" | "failed";
  const settledStatus: ReleaseStatus = releaseError ? "failed" : "ready";
  const releaseStatus: ReleaseStatus = loading ? "searching" : settledStatus;
  const numbered = new Map<number, FeedRelease[]>();
  const packs: FeedRelease[] = [];
  for (const release of result?.releases ?? []) {
    if (release.pack || release.episode === null) {
      packs.push(release);
    } else {
      const group = numbered.get(release.episode) ?? [];
      group.push(release);
      numbered.set(release.episode, group);
    }
  }
  const episodes = [
    ...new Set([
      ...numbered.keys(),
      ...(listed ? entry.completedEpisodes : []),
      ...Array.from({ length: entry.episodes ?? 0 }, (_, index) => index + 1),
    ]),
  ].sort((a, b) => a - b);
  const available = numbered.size;

  return {
    available,
    episodes,
    error: releaseError,
    loading,
    numbered,
    packs,
    releaseStatus,
    reload,
    result,
  };
}
