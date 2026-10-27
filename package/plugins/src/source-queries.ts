import { Effect, Semaphore } from "effect";
import type { DiscoveryResult, FeedRelease } from "./discovery-model";
import type { SourcePluginId } from "./plugin-model";

interface SourceQueries {
  accept: (release: FeedRelease) => boolean;
  active: (source: SourcePluginId) => boolean;
  concurrency?: number;
  enough: (releases: FeedRelease[]) => Effect.Effect<boolean>;
  progress?: (result: DiscoveryResult) => void;
  queries: (source: SourcePluginId) => string[];
  search: (query: string, source: SourcePluginId) => Effect.Effect<DiscoveryResult>;
  sources: SourcePluginId[];
}

/** Interactive searches share three slots; automation retains ordered fallbacks. */
export const collectSourceQueries = Effect.fn("Discovery.collectSourceQueries")(function* (
  plan: SourceQueries
) {
  const releases: FeedRelease[] = [];
  const errors = new Map<SourcePluginId, DiscoveryResult["errors"][number]>();
  const slots = yield* Semaphore.make(3);
  yield* Effect.forEach(
    [...new Set(plan.sources)],
    (source) =>
      Effect.gen(function* () {
        let stopped = false;
        yield* Effect.forEach(
          plan.queries(source),
          (query) =>
            slots.withPermits(1)(
              Effect.gen(function* () {
                if (stopped || !plan.active(source)) {
                  return;
                }
                const found = yield* plan.search(query, source);
                releases.push(...found.releases.filter(plan.accept));
                for (const error of found.errors) {
                  errors.set(error.sourceId, error);
                }
                plan.progress?.({ errors: [...errors.values()], releases });
                stopped =
                  stopped || found.errors.length > 0 || (yield* plan.enough(found.releases));
              })
            ),
          { concurrency: source === "c411" ? 1 : (plan.concurrency ?? 1), discard: true }
        );
      }),
    { concurrency: 3, discard: true }
  );
  // Query variants can reuse feed IDs. Keep every candidate until the caller applies its domain filters.
  return { errors: [...errors.values()], releases };
});

export function uniqueReleases(releases: FeedRelease[]) {
  return [
    ...new Map(releases.map((release) => [`${release.sourceId}:${release.id}`, release])).values(),
  ];
}
