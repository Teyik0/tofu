import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";

test("native updates prepare in the background and can drain services during installation", async () => {
  await using app = await application({ entry: "tests/helpers/updates-native-server.ts" });
  let installed = false;
  const listeners: boolean[] = [];
  const { client } = await app.start({
    onMessage(message) {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "updates-installed"
      ) {
        installed = true;
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "updates-listener" &&
        "active" in message &&
        typeof message.active === "boolean"
      ) {
        listeners.push(message.active);
      }
    },
  });

  expect(success(await client.updates.check.post())).toMatchObject({
    automatic: true,
    latestVersion: "99.0.0",
    status: "available",
  });
  expect(success(await client.updates.prepare.post()).status).toBe("downloading");
  await waitFor(
    async () => success(await client.updates.get()).status,
    (status) => status === "ready"
  );
  expect(success(await client.updates.install.post()).status).toBe("restarting");
  await waitFor(() => installed, Boolean);
  expect(listeners).toEqual([true, false]);
  expect((await client.updates.check.post()).status).toBe(409);
});

test.each([
  { label: "empty", notifications: 1, saved: { notifiedVersion: null } },
  { label: "already notified", notifications: 0, saved: { notifiedVersion: "99.0.0" } },
  { label: "invalid structure", notifications: 1, saved: { notifiedVersion: 123 } },
])("update notification state survives restarts: $label", async ({ saved, notifications }) => {
  await using app = await application({ entry: "tests/helpers/updates-native-server.ts" });
  const directory = join(app.directory, "state");
  await mkdir(directory, { recursive: true });
  const file = Bun.file(join(directory, "release-access.json"));
  await Bun.write(file, JSON.stringify(saved));
  const notified: string[] = [];
  const { client, stop } = await app.start({
    onMessage(message) {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "update-available" &&
        "version" in message &&
        typeof message.version === "string"
      ) {
        notified.push(message.version);
      }
    },
  });

  expect(success(await client.updates.check.post()).status).toBe("available");
  expect(success(await client.updates.check.post()).status).toBe("available");
  await stop();
  expect(notified).toEqual(notifications ? ["99.0.0"] : []);
  expect(await file.json()).toEqual({ notifiedVersion: "99.0.0" });
});
