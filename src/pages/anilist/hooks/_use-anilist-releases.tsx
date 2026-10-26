import { useEffect, useState } from "react";
import type { AniListReleases } from "../../../api/modules/anilist/releases";
import type { AniListEntry, AniListMedia } from "../../../api/modules/anilist/types";
import type { FeedRelease } from "../../../api/modules/discovery/model";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

export function useAniListReleases(entry: AniListMedia | AniListEntry) {
  const { mediaId } = entry;
  const listed = "progress" in entry;
  const [result, setResult] = useState<AniListReleases | null>(null);
  const [partial, setPartial] = useState<FeedRelease[]>([]);
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handle incremental updates, final errors and cancellation in the same request.
    const load = async () => {
      try {
        setResult(null);
        setPartial([]);
        const { data, error } = await api.anilist.entries({ mediaId }).releases.stream.post(
          {},
          {
            fetch: { signal: controller.signal },
          }
        );
        if (error) {
          throw error;
        }
        for await (const message of data) {
          if (controller.signal.aborted) {
            return;
          }
          const event = message.data;
          if (event.type === "error") {
            setReleaseError(event.detail);
          } else if (event.type === "complete") {
            setResult(event.result);
          } else {
            setPartial(event.releases);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setReleaseError(errorMessage(cause, "Unable to find releases"));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [mediaId, searchVersion]);

  type ReleaseStatus = "searching" | "ready" | "failed";
  const settledStatus: ReleaseStatus = releaseError ? "failed" : "ready";
  const releaseStatus: ReleaseStatus = loading ? "searching" : settledStatus;
  const numbered = new Map<number, FeedRelease[]>();
  const packs: FeedRelease[] = [];
  for (const release of result?.releases ?? partial) {
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
    partial,
    releaseStatus,
    reload,
    result,
  };
}
