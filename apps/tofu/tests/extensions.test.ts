import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { PluginAPI } from "@tofu/plugins";
import { application } from "./helpers/app";
import { extensionHost } from "./helpers/extension-host";
import type { createPlugin } from "./helpers/extension-plugin";
import { peer } from "./helpers/peer";
import { waitFor } from "./helpers/poll";

// Exercise installed code through the production API and real torrent worker across restarts.
test("installed plugins preserve settings, credentials and downloaded files across disable and restart", async () => {
  await using host = await extensionHost();
  await using source = await peer();
  await using fixture = await application({ cwd: host.host });
  const first = await fixture.start();
  const { data: initial, error: initialError } = await first.client.extensions.get();
  if (initialError) {
    throw initialError;
  }
  expect(initial.plugins.find((entry) => entry.id === "fixture")?.enabled).toBe(true);
  const { error: settingsError } = await first.client
    .extensions({ id: "fixture" })
    .settings.patch({ patch: { label: "Retained" } });
  if (settingsError) {
    throw settingsError;
  }
  const { error: authError } = await first.client
    .extensions({ id: "fixture" })
    .auth.post({ apiKey: "fixture-key" });
  if (authError) {
    throw authError;
  }
  const installed = treaty<PluginAPI<ReturnType<typeof createPlugin>>>(
    `${first.url}/api/plugins/fixture`
  );
  const { data: status, error: statusError } = await installed.status.get();
  if (statusError) {
    throw statusError;
  }
  expect(status).toMatchObject({
    authenticated: true,
    settings: { label: "Retained" },
    torrents: 0,
  });
  const { data: added, error: addError } = await first.client.torrents.post({
    paused: false,
    source: source.magnet,
  });
  if (addError) {
    throw addError;
  }
  await waitFor(
    async () => {
      const { data, error } = await first.client.torrents({ id: added.id }).get();
      if (error) {
        throw error;
      }
      return data.progress;
    },
    (progress) => progress === 1,
    20_000
  );
  const { error: disableError } = await first.client
    .extensions({ id: "fixture" })
    .enabled.patch({ enabled: false });
  if (disableError) {
    throw disableError;
  }
  expect(await Bun.file(join(host.host, "disposed-fixture-plugin")).text()).toBe("disposed");
  await first.stop();
  const second = await fixture.start();
  const { data: disabled, error: disabledError } = await second.client.extensions.get();
  if (disabledError) {
    throw disabledError;
  }
  const plugin = disabled.plugins.find((entry) => entry.id === "fixture");
  expect(plugin?.enabled).toBe(false);
  expect(plugin?.settings).toMatchObject({ label: "Retained" });
  const { error: enableError } = await second.client
    .extensions({ id: "fixture" })
    .enabled.patch({ enabled: true });
  if (enableError) {
    throw enableError;
  }
  const { data: enabled, error: enabledError } = await second.client.extensions.get();
  if (enabledError) {
    throw enabledError;
  }
  const restored = enabled.plugins.find((entry) => entry.id === "fixture");
  expect(restored?.enabled).toBe(true);
  expect(restored?.auth?.connected).toBe(true);
  expect(
    new Uint8Array(await Bun.file(join(fixture.downloadPath, source.filename)).arrayBuffer())
  ).toEqual(new Uint8Array(source.bytes));
});
