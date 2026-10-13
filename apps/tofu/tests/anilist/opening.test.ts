import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { closeTestOpeningApplications, createTestAniListOpeningApi } from "../helpers/application";
import { expectProblem, expectSuccess } from "../helpers/problem";

afterEach(closeTestOpeningApplications);
test("AniList anime links open in the desktop system browser", async () => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const url = "https://anilist.co/anime/155118/Mahouka-Koukou-no-Rettousei-3rd-Season/";
  const response = await client.anilist.open.post({ url });
  expect(response.status).toBe(200);
  expect(expectSuccess(response)).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});
test("AniList opening reports a native browser launch failure", async () => {
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => false,
  });
  const client = treaty(app).api;
  const response = await client.anilist.open.post({ url: "https://anilist.co/anime/10" });
  expect(response.status).toBe(502);
  await expectProblem(response, 502, "Unable to open AniList in your browser");
});
test("AniList opening reports a synchronous native browser launch failure", async () => {
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => {
      throw new Error("Native launch failed synchronously");
    },
  });
  const client = treaty(app).api;
  const response = await client.anilist.open.post({ url: "https://anilist.co/anime/10" });
  expect(response.status).toBe(502);
  await expectProblem(response, 502, "Unable to open AniList in your browser");
});
test.each([{}, { url: 10 }, { url: "a".repeat(2001) }])(
  "AniList opening rejects an invalid request body with a validation status: %j",
  async (body) => {
    const opened: string[] = [];
    const app = await createTestAniListOpeningApi({
      isDesktop: () => true,
      openExternal: (url) => {
        opened.push(url);
        return true;
      },
    });
    const client = treaty(app).api;
    const response = await client.anilist.open.post(body as never);
    expect(response.status).toBe(422);
    expect(opened).toEqual([]);
  }
);
test("AniList OAuth URLs still open in the desktop system browser", async () => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const url =
    "https://anilist.co/api/v2/oauth/authorize?client_id=52735&response_type=code&state=example";
  const response = await client.anilist.open.post({ url });
  expect(response.status).toBe(200);
  expect(expectSuccess(response)).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});
test("server mode leaves AniList opening to the user's browser", async () => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => false,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const url = "https://anilist.co/anime/10";
  const response = await client.anilist.open.post({ url });
  expect(response.status).toBe(200);
  expect(expectSuccess(response)).toEqual({ opened: false, url });
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
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const response = await client.anilist.open.post({ url });
  expect(response.status).toBe(400);
  await expectProblem(response, 400, "Invalid AniList URL");
  expect(opened).toEqual([]);
});
