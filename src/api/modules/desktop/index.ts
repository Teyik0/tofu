import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { UserError } from "../../lib/errors";
import { services } from "../../lib/services";

export const desktop = new Elysia({ name: "tofu-desktop-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/instance", () => services.instance)
  .post("/directory", async () => {
    if (!services.isDesktop) {
      throw new UserError("Enter the folder path on the server", { status: 409 });
    }
    const { Utils } = services.nativeSdk;
    const paths = await Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: services.engine.settings.downloadPath,
    });
    return { path: paths[0] ?? null };
  })
  .post("/torrents/:id/reveal", async ({ params }) => {
    if (!services.isDesktop) {
      throw new UserError("The folder is on the machine hosting Tofu", { status: 409 });
    }
    return {
      opened: services.nativeSdk.Utils.openPath((await services.engine.detail(params.id)).savePath),
    };
  })
  .get("/desktop", () => {
    if (!services.isDesktop) {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return services.desktop.snapshot();
  })
  .post("/desktop/open", () => {
    if (!services.isDesktop) {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return services.desktop.open();
  })
  .post("/desktop/background", () => {
    if (!services.isDesktop) {
      throw new UserError("This action requires the desktop app", { status: 409 });
    }
    return services.desktop.background();
  })
  .post("/updates/open-download", () => {
    if (!services.isDesktop) {
      return { opened: false };
    }
    if (services.updates.snapshot().status !== "available") {
      throw new UserError("No update available", { status: 409 });
    }
    return services.desktop.openDownload();
  });
