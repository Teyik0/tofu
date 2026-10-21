import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";

test("only one instance owns a data directory and a clean shutdown releases it", async () => {
  await using app = await application();
  const first = await app.start();
  success(await first.client.settings.patch({ downloadLimit: 123_456 }));
  expect(success(await first.client.session.get()).server.id).toBeTruthy();
  await expect(app.start()).rejects.toThrow("already in use");
  expect(success(await first.client.settings.get()).downloadLimit).toBe(123_456);
  await first.stop();
  const restarted = await app.start();
  expect(success(await restarted.client.settings.get()).downloadLimit).toBe(123_456);
});
