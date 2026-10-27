import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("concurrent C411 requests keep their rate-limited order", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "c411" }).put({ apiKey: "test-c411-key", enabled: true }));
  const responses = await Promise.all([
    client.plugins({ id: "c411" }).test.post(),
    client.plugins({ id: "c411" }).test.post(),
  ]);
  for (const response of responses) {
    success(response);
  }
  expect(upstream.state.c411Requests).toHaveLength(2);
  expect(
    (upstream.state.c411Requests[1] ?? 0) - (upstream.state.c411Requests[0] ?? 0)
  ).toBeGreaterThanOrEqual(4000);
});

test("disabling C411 cancels in-flight and queued requests without retaining the permit", async () => {
  const gate = Promise.withResolvers<void>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => gate.resolve());
  await using upstream = provider();
  upstream.state.c411Gate = gate.promise;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "c411" }).put({ apiKey: "test-c411-key", enabled: true }));
  const active = client.plugins({ id: "c411" }).test.post();
  await waitFor(
    () => upstream.state.c411Requests.length,
    (count) => count === 1
  );
  const queued = client.plugins({ id: "c411" }).test.post();
  success(await client.plugins({ id: "c411" }).put({ enabled: false }));
  const responses = await Promise.all([active, queued]);
  for (const response of responses) {
    expect(response.status).toBe(409);
  }
  expect(upstream.state.c411Requests).toHaveLength(1);
  upstream.state.c411Gate = null;
  gate.resolve();
  success(await client.plugins({ id: "c411" }).put({ enabled: true }));
  success(await client.plugins({ id: "c411" }).test.post());
  expect(upstream.state.c411Requests).toHaveLength(2);
});
