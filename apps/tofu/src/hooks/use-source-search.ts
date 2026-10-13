import { useEffect, useState } from "react";
import { request } from "../components/api";
import { errorMessage } from "../lib/errors";
import type { DiscoveryResult, SourcePluginId, SourceSearchState } from "../types";

interface SearchSnapshot {
  key: string;
  sources: SourceSearchState[];
}

export function useSourceSearch(query: string, sourceIds: SourcePluginId[]) {
  const [version, setVersion] = useState(0);
  const ids = sourceIds.join(",");
  const key = JSON.stringify([query, ids, version]);
  const [snapshot, setSnapshot] = useState<SearchSnapshot>({ key: "", sources: [] });
  const searchable = query.length >= 2;

  useEffect(() => {
    if (!(searchable && ids)) {
      return;
    }
    const controller = new AbortController();
    const selected = ids.split(",") as SourcePluginId[];
    const timer = setTimeout(() => {
      setSnapshot({
        key,
        sources: selected.map((sourceId) => ({
          error: null,
          loading: true,
          releases: [],
          sourceId,
          warning: null,
        })),
      });
      for (const sourceId of selected) {
        const finish = (state: SourceSearchState) => {
          if (controller.signal.aborted) {
            return;
          }
          setSnapshot((previous) =>
            previous.key === key
              ? {
                  key,
                  sources: previous.sources.map((source) =>
                    source.sourceId === sourceId ? state : source
                  ),
                }
              : previous
          );
        };
        void request<DiscoveryResult>(
          "/discover",
          "POST",
          { query, sources: [sourceId] },
          controller.signal
        ).then(
          (result) =>
            finish({
              error: result.errors.find((error) => error.sourceId === sourceId)?.message ?? null,
              loading: false,
              releases: result.releases,
              sourceId,
              warning: result.search?.warning ?? null,
            }),
          (cause: unknown) =>
            finish({
              error: errorMessage(cause, "Unable to search the source"),
              loading: false,
              releases: [],
              sourceId,
              warning: null,
            })
        );
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ids, key, query, searchable]);

  let sources: SourceSearchState[] = [];
  if (searchable) {
    sources =
      snapshot.key === key
        ? snapshot.sources
        : sourceIds.map((sourceId) => ({
            error: null,
            loading: true,
            releases: [],
            sourceId,
            warning: null,
          }));
  }
  return { retry: () => setVersion((value) => value + 1), sources };
}
