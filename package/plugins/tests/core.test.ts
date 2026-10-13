import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createCore } from "../src/server";

test("plugins call the host capability facade without mounting host routes", async () => {
  const destinations = [{ id: "thread-one", name: "Anime" }];
  const core = createCore({ threads: { list: () => destinations } });
  expect((await core.handle(new Request("http://localhost/"))).status).toBe(404);
  const api = new Elysia().use(core).get("/threads", ({ core: host }) => host.threads.list());
  const response = await api.handle(new Request("http://localhost/threads"));
  expect(await response.json()).toEqual(destinations);
});
