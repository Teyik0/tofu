import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { destinationIconNames } from "../types";
import type { DesktopController } from "./desktop";
import { type TorrentEngine, UserError } from "./engine";
import { createAutomationApi } from "./feeds/api";
import type { AutomationService } from "./feeds/service";
import { createRequestGuard } from "./request-guard";
import type { UpdatesService } from "./updates";
import { createUpdatesApi } from "./updates-api";

export function createApi(
  engine: () => TorrentEngine,
  sync: FurinSyncOptions,
  automation?: () => AutomationService,
  services?: { updates: () => UpdatesService; desktop: () => DesktopController }
) {
  return new Elysia({ prefix: "/api" })
    .use(createRequestGuard())
    .use(furinSync(sync))
    .guard({ sync: false })
    .error(({ error, set }) => {
      set.status =
        error instanceof Error && "status" in error && typeof error.status === "number"
          ? error.status
          : 500;
      return { error: error instanceof Error ? error.message : "Unexpected error" };
    })
    .use(
      createAutomationApi(
        automation ??
          (() => {
            throw new UserError("Automations unavailable", { status: 503 });
          }),
        sync
      )
    )
    .get("/health", () => ({ ready: Boolean(engine()) }))
    .use(
      createUpdatesApi(
        services?.updates ??
          (() => {
            throw new UserError("Updates unavailable", { status: 503 });
          }),
        sync
      )
    )
    .get("/desktop", () => {
      if (!services || engine().mode !== "desktop") {
        throw new UserError("This action requires the desktop app", { status: 409 });
      }
      return services.desktop().snapshot();
    })
    .post("/desktop/open", () => {
      if (!services || engine().mode !== "desktop") {
        throw new UserError("This action requires the desktop app", { status: 409 });
      }
      return services.desktop().open();
    })
    .post("/desktop/background", () => {
      if (!services || engine().mode !== "desktop") {
        throw new UserError("This action requires the desktop app", { status: 409 });
      }
      return services.desktop().background();
    })
    .post("/updates/open-download", () => {
      if (!services || engine().mode !== "desktop") {
        return { opened: false };
      }
      if (services.updates().snapshot().status !== "available") {
        throw new UserError("No update available", { status: 409 });
      }
      return services.desktop().openDownload();
    })
    .post(
      "/destinations",
      {
        body: t.Object({
          downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
          icon: t.Optional(t.Union(destinationIconNames.map((icon) => t.Literal(icon)))),
          name: t.String({ maxLength: 80, minLength: 1 }),
          pinned: t.Optional(t.Boolean()),
        }),
      },
      ({ body }) => engine().saveDestination(null, body)
    )
    .put(
      "/destinations/:id",
      {
        body: t.Object({
          downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
          icon: t.Optional(t.Union(destinationIconNames.map((icon) => t.Literal(icon)))),
          moveFiles: t.Optional(t.Boolean()),
          name: t.String({ maxLength: 80, minLength: 1 }),
          pinned: t.Optional(t.Boolean()),
        }),
      },
      ({ params, body }) => engine().saveDestination(params.id, body)
    )
    .patch(
      "/destinations/:id",
      {
        body: t.Object({
          icon: t.Optional(t.Union(destinationIconNames.map((icon) => t.Literal(icon)))),
          pinned: t.Optional(t.Boolean()),
        }),
      },
      ({ params, body }) => engine().updateDestinationPresentation(params.id, body)
    )
    .delete("/destinations/:id", ({ params }) => {
      const result = engine().removeDestination(params.id);
      automation?.().reassignDestination(params.id);
      return result;
    })
    .get(
      "/state",
      {
        query: t.Object({ detail: t.Optional(t.String()), selected: t.Optional(t.String()) }),
        sync: { id: "tofu.dashboard", scope: {} },
      },
      ({ query }) => engine().snapshot(query.selected ?? null, query.detail !== "false")
    )
    .get("/torrents/:id", { sync: { id: "tofu.torrent", scope: {} } }, ({ params }) =>
      engine().detail(params.id)
    )
    .post(
      "/torrents",
      {
        body: t.Object({
          destinationId: t.Optional(t.String()),
          downloadPath: t.Optional(t.String()),
          paused: t.Boolean(),
          source: t.String({ maxLength: 65_536, minLength: 1 }),
          trackers: t.Optional(t.Array(t.String())),
        }),
      },
      ({ body }) => engine().add(body.source, body)
    )
    .post(
      "/torrents/file",
      {
        body: t.Object({
          destinationId: t.Optional(t.String()),
          downloadPath: t.Optional(t.String()),
          file: t.File({ maxSize: 8 * 1024 * 1024 }),
          paused: t.String(),
          trackers: t.Optional(t.String()),
        }),
      },
      async ({ body }) =>
        engine().add(new Uint8Array(await body.file.arrayBuffer()), {
          destinationId: body.destinationId,
          downloadPath: body.downloadPath,
          paused: body.paused === "true",
          trackers: body.trackers?.split("\n"),
        })
    )
    .post("/torrents/:id/pause", ({ params }) => engine().pause(params.id))
    .post("/torrents/:id/resume", ({ params }) => engine().resume(params.id))
    .post("/torrents/:id/announce", ({ params }) => engine().reannounce(params.id))
    .post("/torrents/:id/verify", ({ params }) => engine().verify(params.id))
    .put(
      "/torrents/:id/trackers",
      { body: t.Object({ urls: t.Array(t.String({ maxLength: 2048 }), { maxItems: 100 }) }) },
      ({ params, body }) => engine().replaceTrackers(params.id, body.urls)
    )
    .delete("/torrents/:id", { body: t.Object({ deleteFiles: t.Boolean() }) }, ({ params, body }) =>
      engine().remove(params.id, body.deleteFiles)
    )
    .put(
      "/torrents/:id/files/:index",
      {
        body: t.Object({
          priority: t.Union([t.Literal("skip"), t.Literal("normal"), t.Literal("high")]),
        }),
      },
      ({ params, body }) => engine().priority(params.id, Number(params.index), body.priority)
    )
    .post(
      "/torrents/:id/peers",
      { body: t.Object({ peer: t.String({ maxLength: 255, minLength: 1 }) }) },
      ({ params, body }) => engine().addPeer(params.id, body.peer)
    )
    .get("/settings", () => engine().settings)
    .put(
      "/settings",
      {
        body: t.Object({
          downloadLimit: t.Integer({ minimum: -1 }),
          downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
          moveFiles: t.Optional(t.Boolean()),
          runInBackground: t.Optional(t.Boolean()),
          theme: t.Optional(t.Union([t.Literal("system"), t.Literal("light"), t.Literal("dark")])),
          uploadLimit: t.Integer({ minimum: -1 }),
        }),
      },
      ({ body }) => engine().updateSettings(body)
    )
    .post(
      "/bulk",
      {
        body: t.Object({
          action: t.Union([t.Literal("pause"), t.Literal("resume")]),
          ids: t.Optional(t.Array(t.String(), { maxItems: 1000 })),
        }),
      },
      async ({ body }) => {
        const ids =
          body.ids ??
          engine()
            .snapshot(null, false)
            .torrents.map((torrent) => torrent.id);
        await Promise.all(
          ids.map((id) => (body.action === "pause" ? engine().pause(id) : engine().resume(id)))
        );
        return { ok: true };
      }
    )
    .get("/torrents/:id/files/:index/availability", async ({ params }) => {
      await engine().file(params.id, Number(params.index));
      return { ok: true };
    })
    .get("/torrents/:id/files/:index/content", async ({ params }) => {
      const file = await engine().file(params.id, Number(params.index));
      return new Response(Bun.file(file.path), {
        headers: {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        },
      });
    });
}
