import mappings from "./anime-mappings.json";
import { provider } from "./provider";

export const matchingMedia = [
  {
    episodes: null,
    id: 21,
    status: "RELEASING",
    title: { english: "ONE PIECE", romaji: "ONE PIECE" },
  },
  {
    episodes: null,
    id: 235,
    status: "RELEASING",
    title: { english: "Detective Conan", romaji: "Meitantei Conan" },
  },
  {
    episodes: 37,
    id: 1535,
    status: "FINISHED",
    title: { english: "Death Note", romaji: "DEATH NOTE" },
  },
  {
    episodes: 28,
    id: 154_587,
    status: "FINISHED",
    title: { english: "Frieren: Beyond Journey’s End", romaji: "Sousou no Frieren" },
  },
  {
    episodes: 25,
    id: 170_942,
    status: "FINISHED",
    title: { english: "Blue Box", romaji: "Ao no Hako" },
  },
  {
    episodes: 12,
    id: 189_123,
    status: "RELEASING",
    title: { english: "Blue Box Season 2", romaji: "Ao no Hako Season 2" },
  },
  {
    episodes: 13,
    id: 21_459,
    status: "FINISHED",
    title: { english: "My Hero Academia", romaji: "Boku no Hero Academia" },
  },
  {
    episodes: 12,
    id: 131_681,
    status: "FINISHED",
    title: {
      english: "Attack on Titan Final Season Part 2",
      romaji: "Shingeki no Kyojin: The Final Season Part 2",
    },
  },
  {
    episodes: 10,
    id: 185_874,
    status: "FINISHED",
    title: {
      english: "BLEACH: Thousand-Year Blood War - The Calamity",
      romaji: "BLEACH: Sennen Kessen-hen - Kashin-tan",
    },
  },
  {
    episodes: null,
    id: 204_011,
    status: "RELEASING",
    title: { english: "PSYREN", romaji: "PSYЯEN" },
  },
];

export interface ReleaseEntry {
  codec?: string;
  episode?: number | null;
  id: string;
  language?: string;
  metadata?: { anilistId?: number | null } | null;
  quality?: string;
  season?: number | null;
  title: string;
}

export function releaseProvider() {
  const account = provider();
  const state: {
    entries: ReleaseEntry[];
    nyaaRssStatus: number;
    nyaaGate: Promise<void> | null;
    nyaaWaitAfter: number;
    activeNyaa: number;
    maxActiveNyaa: number;
    mappingStatus: number;
    requests: {
      path: string;
      query: string | null;
      rss: boolean;
      quality: string | null;
      codec: string | null;
    }[];
    tsundereStatus: number;
    tsundereGate: Promise<void> | null;
    tsundereIgnoreFilters: boolean;
  } = {
    activeNyaa: 0,
    entries: [],
    mappingStatus: 200,
    maxActiveNyaa: 0,
    nyaaGate: null,
    nyaaRssStatus: 200,
    nyaaWaitAfter: 0,
    requests: [],
    tsundereGate: null,
    tsundereIgnoreFilters: false,
    tsundereStatus: 200,
  };
  const server = Bun.serve({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep HTTP fixture dispatch and provider formats together.
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/anime-mapping") {
        if (state.mappingStatus !== 200) {
          return new Response("Mapping unavailable", { status: state.mappingStatus });
        }
        const id = url.searchParams.get("anilist_id");
        const mapping = Object.entries(mappings).find(([key]) => key === id)?.[1];
        return mapping ? Response.json(mapping) : new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/anilist") {
        const body = (await request.clone().json()) as {
          query: string;
          variables: { mediaId?: number };
        };
        if (body.query.includes("query Anime")) {
          const media = matchingMedia.find((item) => item.id === body.variables.mediaId);
          return Response.json({ data: { Media: media } });
        }
        if (body.query.includes("query Library")) {
          return Response.json({
            data: {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: matchingMedia.map((media) => ({
                      media,
                      mediaId: media.id,
                      progress: 0,
                      status: "CURRENT",
                    })),
                  },
                ],
              },
            },
          });
        }
        return await fetch(new Request(new URL(url.pathname, account.url), request));
      }
      const rss = url.searchParams.get("page") === "rss";
      state.requests.push({
        codec: url.searchParams.get("codec"),
        path: url.pathname,
        quality: url.searchParams.get("quality"),
        query: url.searchParams.get("q"),
        rss,
      });
      if (url.pathname === "/tsundere") {
        if (state.tsundereGate) {
          await state.tsundereGate;
        }
        if (state.tsundereStatus !== 200) {
          return new Response("Unavailable", { status: state.tsundereStatus });
        }
        const entries = state.entries.filter(
          (entry) =>
            state.tsundereIgnoreFilters ||
            ((!url.searchParams.has("quality") ||
              entry.quality === url.searchParams.get("quality")) &&
              (!url.searchParams.has("codec") || entry.codec === url.searchParams.get("codec")))
        );
        return Response.json({
          entries: entries.slice(0, Number(url.searchParams.get("limit") ?? 250)).map((entry) => ({
            ...entry,
            torrentUrl: `https://releases.example.test/${entry.id}.torrent`,
          })),
          options: {
            codec: [
              ...new Set(state.entries.flatMap((entry) => (entry.codec ? [entry.codec] : []))),
            ],
            quality: [
              ...new Set(state.entries.flatMap((entry) => (entry.quality ? [entry.quality] : []))),
            ],
          },
          total: entries.length,
        });
      }
      if (url.pathname === "/nyaa") {
        state.activeNyaa += 1;
        state.maxActiveNyaa = Math.max(state.maxActiveNyaa, state.activeNyaa);
        if (
          state.nyaaGate &&
          state.requests.filter((item) => item.path === "/nyaa").length > state.nyaaWaitAfter
        ) {
          await state.nyaaGate;
        }
        state.activeNyaa -= 1;
      }
      if (url.pathname === "/nyaa" && rss && state.nyaaRssStatus !== 200) {
        return new Response("RSS unavailable", { status: state.nyaaRssStatus });
      }
      const escaped = state.entries.map((entry) => ({
        ...entry,
        title: entry.title
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;"),
      }));
      if (url.pathname === "/nyaa" && !rss) {
        return new Response(
          `<table>${escaped.map((entry, index) => `<tr><td><a href="/view/${index + 1}" title="${entry.title}">${entry.title}</a><a href="/download/${index + 1}.torrent">Download</a></td></tr>`).join("")}</table>`
        );
      }
      return new Response(
        `<rss><channel>${escaped.map((entry) => `<item><guid>https://releases.example.test/${entry.id}</guid><title>${entry.title}</title><link>https://releases.example.test/${entry.id}.torrent</link><torznab:attr name="seeders" value="12"/></item>`).join("")}</channel></rss>`,
        {
          headers: { "content-type": "application/rss+xml" },
        }
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
      await account[Symbol.asyncDispose]();
    },
  };
}
