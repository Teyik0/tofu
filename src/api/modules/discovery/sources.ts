import type { DiscoveryResult, FeedRelease, SourcePluginId } from "../../../types";

interface SourceQueries {
  accept: (release: FeedRelease) => boolean;
  active: (source: SourcePluginId) => boolean;
  enough: (releases: FeedRelease[]) => Promise<boolean>;
  queries: (source: SourcePluginId) => string[];
  search: (query: string, source: SourcePluginId) => Promise<DiscoveryResult>;
  sources: SourcePluginId[];
}

/** Providers run concurrently; query variants within each provider retain their order and limits. */
export async function collectSourceQueries(plan: SourceQueries): Promise<DiscoveryResult> {
  const releases: FeedRelease[] = [];
  const errors = new Map<SourcePluginId, DiscoveryResult["errors"][number]>();
  await Promise.all(
    [...new Set(plan.sources)].map(async (source) => {
      const queries = plan.queries(source);
      for (const [index, query] of queries.entries()) {
        if (!plan.active(source)) {
          break;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Preserve provider limits and ordered fallback queries.
        const found = await plan.search(query, source);
        releases.push(...found.releases.filter(plan.accept));
        for (const error of found.errors) {
          errors.set(error.sourceId, error);
        }
        if (found.errors.length || index === queries.length - 1) {
          break;
        }
        const enough = await plan.enough(found.releases);
        if (enough) {
          break;
        }
      }
    })
  );
  // Query variants can reuse feed IDs. Keep every candidate until the caller applies its domain filters.
  return { errors: [...errors.values()], releases };
}

export function uniqueReleases(releases: FeedRelease[]) {
  return [
    ...new Map(releases.map((release) => [`${release.sourceId}:${release.id}`, release])).values(),
  ];
}
