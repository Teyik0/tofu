import { expect, test } from "bun:test";
import { createTestAniListOpeningApi } from "./api-fixture";
import { json } from "./helpers";

test("AniList anime links open in the desktop system browser", async () => {
  const opened: string[] = [];
  const app = createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return Promise.resolve(true);
    },
  });
  const url = "https://anilist.co/anime/155118/Mahouka-Koukou-no-Rettousei-3rd-Season/";
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url }))
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});

test("AniList opening reports a native browser launch failure", async () => {
  const app = createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => Promise.resolve(false),
  });
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url: "https://anilist.co/anime/10" }))
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Unable to open AniList in your browser" });
});

test("AniList opening reports a rejected native browser launch", async () => {
  const app = createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => Promise.reject(new Error("Native launch failed")),
  });
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url: "https://anilist.co/anime/10" }))
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Unable to open AniList in your browser" });
});

test.each([{}, { url: 10 }, { url: "a".repeat(2001) }])(
  "AniList opening rejects an invalid request body with a validation status: %j",
  async (body) => {
    const opened: string[] = [];
    const app = createTestAniListOpeningApi({
      isDesktop: () => true,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
    });
    const response = await app.handle(new Request("http://localhost/api/anilist/open", json(body)));
    expect(response.status).toBe(422);
    expect(opened).toEqual([]);
  }
);

test("AniList OAuth URLs still open in the desktop system browser", async () => {
  const opened: string[] = [];
  const app = createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return Promise.resolve(true);
    },
  });
  const url =
    "https://anilist.co/api/v2/oauth/authorize?client_id=52735&response_type=code&state=example";
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url }))
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});

test("server mode leaves AniList opening to the user's browser", async () => {
  const opened: string[] = [];
  const app = createTestAniListOpeningApi({
    isDesktop: () => false,
    openExternal: (target) => {
      opened.push(target);
      return Promise.resolve(true);
    },
  });
  const url = "https://anilist.co/anime/10";
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url }))
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ opened: false, url });
  expect(opened).toEqual([]);
});

test.each([
  "invalid",
  "http://anilist.co/anime/10",
  "https://example.com/anime/10",
  "https://anilist.co.evil.test/anime/10",
  "https://user:password@anilist.co/anime/10",
  "file:///tmp/anime/10",
  "javascript:alert(1)",
  "https://anilist.co/settings",
])("AniList opening rejects unsupported URL %s", async (url) => {
  const opened: string[] = [];
  const app = createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return Promise.resolve(true);
    },
  });
  const response = await app.handle(
    new Request("http://localhost/api/anilist/open", json({ url }))
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid AniList URL" });
  expect(opened).toEqual([]);
});
