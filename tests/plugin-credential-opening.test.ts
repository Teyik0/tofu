import { afterEach, expect, test } from "bun:test";
import { closeTestOpeningApplications, createTestAniListOpeningApi } from "./api-fixture";
import { json } from "./helpers";

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
      return Promise.resolve(true);
    },
  });
  const response = await app.handle(
    new Request(`http://localhost/api/plugins/${id}/credentials/open`, json({}))
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ opened: true, url });
  expect(opened).toEqual([url]);
});

test("server mode returns the credential page for an ordinary browser link", async () => {
  const opened: string[] = [];
  const app = await createTestAniListOpeningApi({
    isDesktop: () => false,
    openExternal: (target) => {
      opened.push(target);
      return Promise.resolve(true);
    },
  });
  const response = await app.handle(
    new Request("http://localhost/api/plugins/c411/credentials/open", json({}))
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
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
      return Promise.resolve(true);
    },
  });
  const response = await app.handle(
    new Request(`http://localhost/api/plugins/${id}/credentials/open`, json({}))
  );
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
      return Promise.resolve(false);
    },
  });
  const response = await app.handle(
    new Request("http://localhost/api/plugins/jev/credentials/open", json({}))
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "Unable to open the API key page in your browser",
  });
});
