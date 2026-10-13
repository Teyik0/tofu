import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { closeTestOpeningApplications, createTestAniListOpeningApi } from "./helpers/application";
import { expectProblem, expectSuccess } from "./helpers/problem";

afterEach(closeTestOpeningApplications);
test.each([
  ["c411", "https://c411.org/user/integrations"],
  ["jev", "https://console.typesafe.ai/keys"],
])("%s opens its API key page in the desktop system browser", async (id, url) => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const response = await client.plugins({ id }).credentials.open.post({});
  expect(response.status).toBe(200);
  expect(expectSuccess(response)).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});
test("server mode returns the credential page for an ordinary browser link", async () => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => false,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const response = await client.plugins({ id: "c411" }).credentials.open.post({});
  expect(response.status).toBe(200);
  expect(expectSuccess(response)).toEqual({
    opened: false,
    url: "https://c411.org/user/integrations",
  });
  expect(opened).toEqual([]);
});
test.each(["anilist", "unknown"])("credential pages reject unsupported plugin %s", async (id) => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: (target) => {
      opened.push(target);
      return true;
    },
  });
  const client = treaty(app).api;
  const response = await client.plugins({ id }).credentials.open.post({});
  expect(response.status).toBe(400);
  expect(opened).toEqual([]);
});
test.each(["rejected", "throw"])("credential pages report a %s browser launch", async (failure) => {
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => {
      if (failure === "throw") {
        throw new Error("Native launch failed");
      }
      return false;
    },
  });
  const client = treaty(app).api;
  const response = await client.plugins({ id: "jev" }).credentials.open.post({});
  expect(response.status).toBe(502);
  await expectProblem(response, 502, "Unable to open the API key page in your browser");
});
