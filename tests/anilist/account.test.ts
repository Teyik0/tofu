import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { provider } from "../helpers/provider";

test("AniList validates its OAuth callback and disconnecting removes account access", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  expect(success(await client.session.get()).capabilities.hostNative).toBe(false);
  expect(success(await client.state.get()).viewer?.capabilities.hostNative).toBe(false);
  expect((await client.desktop.open.post()).status).toBe(409);
  success(
    await client.anilist.put({
      clientId: "52735",
      redirectUri: "tofu-dev://oauth/anilist",
      userName: "",
    })
  );
  const authorization = success(await client.anilist.connect.post({}));
  expect(success(await client.anilist.open.post({ url: authorization.url }))).toEqual({
    opened: false,
    url: authorization.url,
  });
  const state = new URL(authorization.url).searchParams.get("state");
  expect(state).toBeTruthy();
  const invalid = await client.anilist.callback.post({
    url: "tofu-dev://oauth/anilist#state=invalid&access_token=test-anilist-token",
  });
  expect(invalid.status).toBe(400);
  expect(success(await client.anilist.get()).authenticated).toBe(false);
  const callback = `tofu-dev://oauth/anilist#${new URLSearchParams({ access_token: "test-anilist-token", state: state ?? "" })}`;
  const connected = success(await client.anilist.callback.post({ url: callback }));
  expect(connected.authenticated).toBe(true);
  expect(connected.connectedUser).toBe("ExampleUser");
  expect(connected.entries[0]?.mediaId).toBe(10);
  expect(JSON.stringify(connected)).not.toContain("test-anilist-token");
  expect((await client.anilist.callback.post({ url: callback })).status).toBe(400);

  success(await client.plugins({ id: "anilist" }).put({ apiKey: "", enabled: false }));
  const disconnected = success(await client.anilist.get());
  expect(disconnected.authenticated).toBe(false);
  expect(disconnected.entries).toEqual([]);
  expect(
    (await client.anilist.entries({ mediaId: "10" }).editor.put({ notes: "Must not save" })).status
  ).toBe(409);
  expect(upstream.state.writes).toEqual([]);
});
