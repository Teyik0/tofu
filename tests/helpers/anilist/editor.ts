import { expect } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { createTestApi } from "../application";
import { openTestServices } from "../services";
import { fixture } from "../torrent";
export async function editorFixture() {
  const context = await fixture(1024, []);
  const media = { episodes: 12, id: 10, synonyms: [], title: { romaji: "Example" } };
  const options = {
    animeList: {
      advancedScoring: ["Story", "Animation"],
      advancedScoringEnabled: true,
      customLists: ["Weekend"],
    },
    scoreFormat: "POINT_3",
  };
  let entry = {
    advancedScores: { Animation: 80, Story: 90 },
    completedAt: { day: null, month: null, year: null },
    customLists: { Weekend: true },
    hiddenFromStatusLists: false,
    id: 100,
    media,
    mediaId: 10,
    notes: "Original notes",
    priority: 0,
    private: false,
    progress: 2,
    repeat: 0,
    score: 3,
    startedAt: { day: null, month: 10, year: 2026 },
    status: "CURRENT",
  };
  const remote: {
    favourite: boolean;
    favouriteWrites: number;
    listed: boolean;
    reject: boolean;
    saves: number;
  } = { favourite: false, favouriteWrites: 0, listed: true, reject: false, saves: 0 };
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as { query: string; variables: Partial<typeof entry> };
      if (remote.reject && body.query.includes("mutation")) {
        return Response.json({ errors: [{ message: "Unavailable" }] });
      }
      if (body.query.includes("mutation ToggleAnimeFavourite")) {
        remote.favourite = !remote.favourite;
        remote.favouriteWrites += 1;
        return Response.json({ data: { ToggleFavourite: { anime: { nodes: [{ id: 10 }] } } } });
      }
      if (body.query.includes("mutation DeleteEntry")) {
        remote.listed = false;
        return Response.json({ data: { DeleteMediaListEntry: { deleted: true } } });
      }
      expect(incoming.headers.get("authorization")).toBe("Bearer token");
      if (body.query.includes("mutation SaveEntry")) {
        remote.saves += 1;
        remote.listed = true;
        entry = { ...entry, ...body.variables, customLists: { Weekend: true } };
        return Response.json({ data: { SaveMediaListEntry: entry } });
      }
      if (body.query.includes("query Editor")) {
        return Response.json({
          data: {
            Media: {
              ...media,
              isFavourite: remote.favourite,
              isFavouriteBlocked: false,
              mediaListEntry: remote.listed ? entry : null,
            },
            Viewer: { id: 42, mediaListOptions: options, name: "ExampleUser" },
          },
        });
      }
      return Response.json({
        data: body.query.includes("query Viewer")
          ? { Viewer: { id: 42, name: "ExampleUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [{ entries: remote.listed ? [entry] : [] }],
              },
            },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${provider.port}`;
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  await client.plugins({ id: "anilist" }).put({ apiKey: "token", enabled: true });
  await client.anilist.list.post({});
  return {
    bytes: context.bytes,
    client: treaty(api).api,
    close: async () => {
      await api.application.close();
      provider.stop(true);
      await context.close();
    },
    magnet: context.magnet,
    remote,
  };
}
