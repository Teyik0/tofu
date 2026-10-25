import { Effect } from "effect";
import type { SourcePluginId } from "../plugins/model";
import type { DiscoveryResult, FeedRelease } from "./model";

interface SourceQueries {
  accept: (release: FeedRelease) => boolean;
  active: (source: SourcePluginId) => boolean;
  enough: (releases: FeedRelease[]) => Effect.Effect<boolean>;
  queries: (source: SourcePluginId) => string[];
  search: (query: string, source: SourcePluginId) => Effect.Effect<DiscoveryResult>;
  sources: SourcePluginId[];
}

/** Providers run concurrently; query variants within each provider retain their order and limits. */
export const collectSourceQueries = Effect.fn("Discovery.collectSourceQueries")(function* (
  plan: SourceQueries
) {
  const releases: FeedRelease[] = [];
  const errors = new Map<SourcePluginId, DiscoveryResult["errors"][number]>();
  yield* Effect.forEach(
    [...new Set(plan.sources)],
    (source) =>
      Effect.gen(function* () {
        const queries = plan.queries(source);
        for (const [index, query] of queries.entries()) {
          if (!plan.active(source)) {
            break;
          }
          // Preserve provider limits and ordered fallback queries.
          const found = yield* plan.search(query, source);
          releases.push(...found.releases.filter(plan.accept));
          for (const error of found.errors) {
            errors.set(error.sourceId, error);
          }
          if (found.errors.length || index === queries.length - 1) {
            break;
          }
          const enough = yield* plan.enough(found.releases);
          if (enough) {
            break;
          }
        }
      }),
    { concurrency: "unbounded", discard: true }
  );
  // Query variants can reuse feed IDs. Keep every candidate until the caller applies its domain filters.
  return { errors: [...errors.values()], releases };
});

export function uniqueReleases(releases: FeedRelease[]) {
  return [
    ...new Map(releases.map((release) => [`${release.sourceId}:${release.id}`, release])).values(),
  ];
}
