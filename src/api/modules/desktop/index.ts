import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { UserError } from "../../lib/errors";

export const desktopPlugin = new Elysia({ name: "tofu-desktop-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/instance", ({ application }) => application.instance)
  .post("/directory", async ({ application }) => {
    if (application.platform.kind !== "desktop") {
      throw new UserError("Enter the folder path on the server", { status: 409 });
    }
    const Utils = application.platform.utils;
    const paths = await Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: application.engine.settings.downloadPath,
    });
    return { path: paths[0] ?? null };
  })
  .post("/torrents/:id/reveal", async ({ application, params }) => {
    if (application.platform.kind !== "desktop") {
      throw new UserError("The folder is on the machine hosting Tofu", { status: 409 });
    }
    return {
      opened: application.platform.utils.openPath(
        (await application.engine.detail(params.id)).savePath
      ),
    };
  })
  .get("/desktop", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return application.platform.controller.snapshot();
  })
  .post("/desktop/open", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return application.platform.controller.open();
  })
  .post("/desktop/background", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return application.platform.controller.background();
  })
  .post("/updates/open-download", ({ application }) => {
    if (application.platform.kind !== "desktop") {
      return { opened: false };
    }
    if (application.updates.snapshot().status !== "available") {
      throw new UserError("No update available", { status: 409 });
    }
    return application.platform.controller.openDownload();
  });
