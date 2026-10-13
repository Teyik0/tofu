// biome-ignore-all lint/performance/noAwaitInLoops: exercise ordered public API mutations and real transfers.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AniListState,
  AniListSubscription,
  AutomationDraft,
  AutomationState,
  DashboardState,
  Destination,
} from "../../src/types";
import { threadFixture } from "../helpers/anilist/threads";
import { expectSuccess } from "../helpers/problem";
import { torrentBytes, waitFor } from "../helpers/torrent";

test("AniList proposes one thread per selected anime under a root without creating folders", async () => {
  const context = await threadFixture();
  try {
    const basePath = join(context.directory, "video");
    const response = await context.client.anilist.threads.preview.post({
      basePath,
      statuses: ["CURRENT", "PLANNING"],
    });
    expect(response.status).toBe(200);
    expect(expectSuccess(response)).toEqual([
      {
        destinationId: null,
        downloadPath: join(basePath, "one-piece"),
        mediaId: 21,
        name: "One Piece",
      },
      {
        destinationId: null,
        downloadPath: join(basePath, "example"),
        mediaId: 10,
        name: "Example",
      },
    ]);
    expect(existsSync(basePath)).toBe(false);
    expect(expectSuccess(await context.client.state.get()).destinations).toHaveLength(1);
  } finally {
    await context.close();
  }
});
test("AniList creates linked Nyaa rules in per-anime threads with overrides and keeps destinations across sync, pause and restart", async () => {
  const context = await threadFixture();
  try {
    const basePath = join(context.directory, "video");
    const customPath = join(context.directory, "custom-one-piece");
    const existing = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "existing"),
        name: "Existing",
      })
    ) as Destination;
    const template = expectSuccess(
      await context.client.automations.interpret.post({
        destinationId: "default",
        query: "VOSTFR 1080p Nyaa",
      })
    ) as AutomationDraft;
    const created = await context.client.anilist.subscriptions.post({
      enabled: true,
      intervalMinutes: 15,
      organization: {
        basePath,
        mode: "per-anime",
        overrides: [
          { destinationId: null, downloadPath: customPath, mediaId: 21, name: "OP" },
          {
            destinationId: existing.id,
            downloadPath: existing.downloadPath,
            mediaId: 10,
            name: existing.name,
          },
        ],
      },
      statuses: ["CURRENT", "PLANNING"],
      template: { ...template, includeExisting: true, sources: ["nyaa"] },
    });
    expect(created.status).toBe(200);
    const subscription = expectSuccess(created) as AniListSubscription;
    const synced = expectSuccess(
      await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({})
    ) as AniListState;
    expect(synced.subscriptions[0]?.error).toBeNull();
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
    const onePiece = state.automations.find((rule) => rule.title === "One Piece");
    expect(onePiece).toBeDefined();
    expect(onePiece?.destinationId).not.toBe("default");
    const { destinations } = expectSuccess(await context.client.state.get()) as {
      destinations: Destination[];
    };
    expect(
      destinations.find((destination) => destination.id === onePiece?.destinationId)
    ).toMatchObject({ downloadPath: customPath, name: "OP" });
    expect(state.automations.find((rule) => rule.title === "Example")?.destinationId).toBe(
      existing.id
    );
    expect(
      synced.subscriptions[0]?.bindings.find((binding) => binding.mediaId === 21)?.ruleId
    ).toBe(onePiece?.id);
    await waitFor(
      async () =>
        expectSuccess(
          await context.client.state.get({ query: { selected: context.seed.infoHash } })
        ),
      (value) => value.detail?.status === "seeding"
    );
    expect(
      expectSuccess(await context.client.torrents({ id: context.seed.infoHash }).get()).savePath
    ).toBe(customPath);
    const tested = expectSuccess(await context.client.plugins({ id: "anilist" }).test.post({}));
    expect(tested.automations).toHaveLength(2);
    expectSuccess(await context.client.plugins({ id: "anilist" }).put({ enabled: false }));
    const suspended = expectSuccess(await context.client.automation.get());
    expect(suspended.automations.every((rule) => !rule.enabled)).toBe(true);
    const paused = expectSuccess(await context.client.anilist.get());
    expect(paused.subscriptions[0]?.bindings.every((binding) => !binding.active)).toBe(true);
    expectSuccess(await context.client.plugins({ id: "anilist" }).put({ enabled: true }));
    expectSuccess(
      await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({})
    );
    const resumed = expectSuccess(await context.client.automation.get());
    expect(resumed.automations.every((rule) => rule.enabled)).toBe(true);
    await context.client.anilist.subscriptions({ id: subscription.id }).put({ enabled: false });
    await context.restart();
    await context.client.anilist.subscriptions({ id: subscription.id }).put({ enabled: true });
    await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const again = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(again.automations).toHaveLength(2);
    expect(again.automations.find((rule) => rule.id === onePiece?.id)?.destinationId).toBe(
      onePiece?.destinationId
    );
    expect(
      (expectSuccess(await context.client.state.get()) as { destinations: Destination[] })
        .destinations
    ).toHaveLength(3);
    expect(
      new Uint8Array(
        torrentBytes(
          await context.client
            .torrents({ id: context.seed.infoHash })
            .files({ index: "0" })
            .content.get()
        )
      )
    ).toEqual(context.bytes);
    await context.client.anilist.entries({ mediaId: "22" }).put({ enabled: true });
    await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const followed = expectSuccess(await context.client.automation.get()) as AutomationState;
    const later = followed.automations.find((rule) => rule.title === "Unselected");
    const updated = expectSuccess(await context.client.state.get()) as {
      destinations: Destination[];
    };
    expect(
      updated.destinations.find((destination) => destination.id === later?.destinationId)
    ).toMatchObject({ downloadPath: join(basePath, "unselected"), name: "Unselected" });
  } finally {
    await context.close();
  }
});
test("deleting an AniList thread reassigns its rules and subscriptions without recreating it on sync or restart", async () => {
  const context = await threadFixture();
  try {
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "anime"),
        name: "Anime",
      })
    ) as Destination;
    const template = expectSuccess(
      await context.client.automations.interpret.post({
        destinationId: destination.id,
        query: "Example Nyaa",
      })
    ) as AutomationDraft;
    const subscription = expectSuccess(
      await context.client.anilist.subscriptions.post({
        enabled: true,
        intervalMinutes: 15,
        organization: {
          basePath: join(context.directory, "video"),
          mode: "per-anime",
          overrides: [
            {
              destinationId: destination.id,
              downloadPath: destination.downloadPath,
              mediaId: 10,
              name: destination.name,
            },
          ],
        },
        statuses: ["CURRENT"],
        template: { ...template, includeExisting: true },
      })
    ) as AniListSubscription;
    await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const response = await context.client.destinations({ id: destination.id }).delete({});
    expect(response.status).toBe(200);
    await context.restart();
    const synced = expectSuccess(
      await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({})
    ) as AniListState;
    expect(synced.subscriptions[0]?.error).toBeNull();
    expect(synced.subscriptions[0]?.template.destinationId).toBe("default");
    const organization = synced.subscriptions[0]?.organization;
    expect(organization?.mode).toBe("per-anime");
    expect(organization?.mode === "per-anime" && organization.overrides[0]?.destinationId).toBe(
      "default"
    );
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(state.automations).toHaveLength(1);
    expect(state.automations[0]?.destinationId).toBe("default");
    expect(expectSuccess(await context.client.state.get()).destinations).toHaveLength(1);
  } finally {
    await context.close();
  }
});
test("deleting the default tab keeps the next tab's rules and subscriptions on that tab after restart", async () => {
  const context = await threadFixture();
  try {
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "anime"),
        name: "Anime",
      })
    ) as Destination;
    const template = expectSuccess(
      await context.client.automations.interpret.post({
        destinationId: destination.id,
        query: "Example Nyaa",
      })
    ) as AutomationDraft;
    const subscription = expectSuccess(
      await context.client.anilist.subscriptions.post({
        enabled: true,
        intervalMinutes: 15,
        statuses: ["CURRENT"],
        template: { ...template, includeExisting: true },
      })
    ) as AniListSubscription;
    await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({});
    const response = await context.client.destinations({ id: "default" }).delete({});
    expect(response.status).toBe(200);
    await context.restart();
    const synced = expectSuccess(
      await context.client.anilist.subscriptions({ id: subscription.id }).sync.post({})
    ) as AniListState;
    expect(synced.subscriptions[0]?.error).toBeNull();
    expect(synced.subscriptions[0]?.template.destinationId).toBe("default");
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(state.automations.map((rule) => rule.destinationId)).toEqual(["default"]);
    expect(
      (expectSuccess(await context.client.state.get()) as DashboardState).destinations
    ).toEqual([{ ...destination, id: "default" }]);
  } finally {
    await context.close();
  }
});
test("AniList rejects invalid thread overrides before creating a subscription or folders", async () => {
  const context = await threadFixture();
  try {
    const basePath = join(context.directory, "video");
    const template = expectSuccess(
      await context.client.automations.interpret.post({
        destinationId: "default",
        query: "Nyaa VOSTFR",
      })
    ) as AutomationDraft;
    for (const override of [
      { destinationId: null, downloadPath: "relative", mediaId: 21, name: "One Piece" },
      {
        destinationId: "unknown",
        downloadPath: join(basePath, "one-piece"),
        mediaId: 21,
        name: "One Piece",
      },
    ]) {
      const response = await context.client.anilist.subscriptions.post({
        enabled: true,
        intervalMinutes: 15,
        organization: { basePath, mode: "per-anime", overrides: [override] },
        statuses: ["PLANNING"],
        template,
      });
      expect(response.status).toBe(400);
    }
    expect(
      (expectSuccess(await context.client.anilist.get()) as AniListState).subscriptions
    ).toHaveLength(0);
    expect(existsSync(basePath)).toBe(false);
  } finally {
    await context.close();
  }
});
