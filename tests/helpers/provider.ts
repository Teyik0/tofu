import type { peer } from "./peer";

export function provider(source?: Awaited<ReturnType<typeof peer>>) {
  const state: {
    failSource: boolean;
    notes: string;
    progress: number;
    published: boolean;
    status: string;
    writes: { variables: Record<string, unknown>; token: string | null }[];
  } = {
    failSource: false,
    notes: "",
    progress: 0,
    published: true,
    status: "CURRENT",
    writes: [],
  };
  const media = {
    episodes: 12,
    format: "TV",
    genres: ["Action"],
    id: 10,
    siteUrl: "https://anilist.co/anime/10",
    status: "RELEASING",
    synonyms: [],
    title: { english: "Example", romaji: "Example" },
  };
  const server = Bun.serve({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the fixture's HTTP provider contracts together.
    async fetch(request) {
      if (new URL(request.url).pathname === "/nyaa") {
        if (state.failSource) {
          return new Response("Provider unavailable", { status: 503 });
        }
        const item =
          source && state.published
            ? `<item><guid>episode-1</guid><title>Example - 01 VOSTFR 1080p x264</title><link>${source.magnet.replaceAll("&", "&amp;")}</link><nyaa:infoHash>${source.id}</nyaa:infoHash></item>`
            : "";
        return new Response(`<rss><channel>${item}</channel></rss>`, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const token = request.headers.get("authorization");
      const entry = {
        advancedScores: {},
        completedAt: { day: null, month: null, year: null },
        customLists: {},
        hiddenFromStatusLists: false,
        id: 100,
        media,
        mediaId: 10,
        notes: state.notes,
        priority: 0,
        private: false,
        progress: state.progress,
        repeat: 0,
        score: 0,
        startedAt: { day: null, month: null, year: null },
        status: state.status,
      };
      if (query.includes("mutation")) {
        if (token !== "Bearer test-anilist-token") {
          return Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
        }
        state.writes.push({ token, variables });
        if (typeof variables.progress === "number") {
          state.progress = variables.progress;
        }
        if (typeof variables.notes === "string") {
          state.notes = variables.notes;
        }
        if (typeof variables.status === "string") {
          state.status = variables.status;
        }
        return Response.json({
          data: {
            SaveMediaListEntry: {
              ...entry,
              notes: state.notes,
              progress: state.progress,
              status: state.status,
            },
          },
        });
      }
      const viewer = {
        id: 42,
        mediaListOptions: {
          animeList: { advancedScoring: [], advancedScoringEnabled: false, customLists: [] },
          scoreFormat: "POINT_10",
        },
        name: "ExampleUser",
      };
      if (query.includes("query Viewer")) {
        return token === "Bearer test-anilist-token"
          ? Response.json({ data: { Viewer: viewer } })
          : Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
      }
      if (query.includes("query Library")) {
        return Response.json({
          data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: [entry] }] } },
        });
      }
      if (query.includes("query Editor")) {
        return Response.json({
          data: {
            Media: {
              ...media,
              isFavourite: false,
              isFavouriteBlocked: false,
              mediaListEntry: entry,
            },
            Viewer: viewer,
          },
        });
      }
      if (query.includes("query Anime")) {
        return Response.json({ data: { Media: media } });
      }
      if (query.includes("query CatalogOptions")) {
        return Response.json({
          data: {
            ExternalLinkSourceCollection: [],
            GenreCollection: ["Action"],
            MediaTagCollection: [],
          },
        });
      }
      if (query.includes("query Catalog")) {
        return Response.json({
          data: {
            Page: {
              media: [media],
              pageInfo: { currentPage: variables.page ?? 1, hasNextPage: false },
            },
          },
        });
      }
      return Response.json(
        { errors: [{ message: "Unexpected GraphQL operation" }] },
        { status: 400 }
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    state,
    url: server.url.origin,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
    },
  };
}
