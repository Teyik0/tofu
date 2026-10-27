import type { peer } from "./peer";

export function provider(source?: Awaited<ReturnType<typeof peer>>) {
  const state: {
    anilistGate: Promise<void> | null;
    anilistRequests: number;
    anilistStatus: number;
    c411Gate: Promise<void> | null;
    c411Requests: number[];
    failSource: boolean;
    notificationRequests: { variables: Record<string, unknown>; token: string | null }[];
    notifications: { type: string; [key: string]: unknown }[];
    unreadCount: number;
    notes: string;
    progress: number;
    listed: boolean;
    published: boolean;
    status: string;
    writes: { variables: Record<string, unknown>; token: string | null }[];
  } = {
    anilistGate: null,
    anilistRequests: 0,
    anilistStatus: 200,
    c411Gate: null,
    c411Requests: [],
    failSource: false,
    listed: true,
    notes: "",
    notificationRequests: [],
    notifications: [],
    progress: 0,
    published: true,
    status: "CURRENT",
    unreadCount: 2,
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
    title: { english: "Example", native: null, romaji: "Example" },
  };
  state.notifications.push(
    {
      __typename: "AiringNotification",
      animeId: 10,
      contexts: ["Episode ", " of ", " aired."],
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      episode: 1,
      id: 500,
      media: { ...media, type: "ANIME" },
      type: "AIRING",
    },
    {
      __typename: "FollowingNotification",
      context: " started following you.",
      createdAt: Math.floor(Date.now() / 1000) - 7200,
      id: 499,
      type: "FOLLOWING",
      user: {
        avatar: { large: null },
        name: "AnimeFriend",
        siteUrl: "https://anilist.co/user/AnimeFriend",
      },
    },
    ...Array.from({ length: 30 }, (_, index) => ({
      __typename: "AiringNotification",
      animeId: 10,
      contexts: ["Episode ", " of ", " aired."],
      createdAt: Math.floor(Date.now() / 1000) - (index + 1) * 86_400,
      episode: index + 2,
      id: 498 - index,
      media: { ...media, type: "ANIME" },
      type: "AIRING",
    }))
  );
  const server = Bun.serve({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the fixture's HTTP provider contracts together.
    async fetch(request) {
      if (new URL(request.url).pathname === "/anime-mapping") {
        return Response.json({
          episodes: { "1": { absoluteEpisodeNumber: 1, episodeNumber: 1, seasonNumber: 1 } },
          mappings: { anilist_id: 10 },
          titles: { en: "Example" },
        });
      }
      if (new URL(request.url).pathname === "/c411") {
        state.c411Requests.push(Date.now());
        if (state.c411Gate) {
          await state.c411Gate;
        }
        return new Response("<rss><channel></channel></rss>", {
          headers: { "content-type": "application/rss+xml" },
        });
      }
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
      state.anilistRequests += 1;
      if (state.anilistGate) {
        await state.anilistGate;
      }
      if (state.anilistStatus !== 200) {
        return Response.json(
          { errors: [{ message: "Private provider diagnostics" }] },
          { status: state.anilistStatus }
        );
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
        if (query.includes("SaveMediaListEntry")) {
          state.listed = true;
        }
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
        avatar: { large: "https://images.example.test/anilist-avatar.png" },
        id: 42,
        mediaListOptions: {
          animeList: { advancedScoring: [], advancedScoringEnabled: false, customLists: [] },
          scoreFormat: "POINT_10",
        },
        name: "ExampleUser",
      };
      if (query.includes("query Notifications")) {
        if (token !== "Bearer test-anilist-token") {
          return Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
        }
        state.notificationRequests.push({ token, variables });
        if (variables.reset) {
          state.unreadCount = 0;
        }
        const types = variables.types as string[] | undefined;
        const notifications = state.notifications.filter(
          (item) => !types || types.includes(item.type)
        );
        const page = Number(variables.page);
        return Response.json({
          data: {
            Page: {
              notifications: notifications.slice((page - 1) * 30, page * 30),
              pageInfo: { currentPage: page, hasNextPage: page * 30 < notifications.length },
            },
            Viewer: { ...viewer, unreadNotificationCount: state.unreadCount },
          },
        });
      }
      if (query.includes("query Viewer")) {
        return token === "Bearer test-anilist-token"
          ? Response.json({ data: { Viewer: viewer } })
          : Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
      }
      if (query.includes("query Library")) {
        return Response.json({
          data: {
            MediaListCollection: {
              hasNextChunk: false,
              lists: [{ entries: state.listed ? [entry] : [] }],
            },
          },
        });
      }
      if (query.includes("query Editor")) {
        return Response.json({
          data: {
            Media: {
              ...media,
              isFavourite: false,
              isFavouriteBlocked: false,
              mediaListEntry: state.listed ? entry : null,
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
    idleTimeout: 30,
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
