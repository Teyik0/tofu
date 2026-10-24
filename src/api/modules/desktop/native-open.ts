import { getDesktopHost } from "@teyik0/furin-electrobun/host";
import { Elysia, ElysiaStatus } from "elysia";
import { nativeControl } from "../../../native/control";
import { instance } from "../../lib/instance";
import { anilistServicePlugin } from "../anilist/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { torrentOpenings } from "./service";

export const desktopNativeOpenPlugin = new Elysia({
  name: "tofu-desktop-native-open",
})
  .use(anilistServicePlugin)
  .use(torrentServicePlugin)
  .decorate((dependencies) => {
    const { anilist, torrents } = dependencies;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep native input validation and error handling at the event boundary.
    nativeControl.tofuNativeOpen = async ({ data: { url } }) => {
      const desktop = getDesktopHost();
      const sdk = nativeControl.tofuNativeSdk;

      if (!(desktop && sdk)) {
        return;
      }

      try {
        const identity = await sdk.Updater.getLocalInfo();

        if (
          await nativeControl.tofuNativeHost?.onOpen({
            desktop,
            event: { type: "url", url },
            identity,
          })
        ) {
          return;
        }

        if (["tofu:", "tofu-dev:"].includes(new URL(url).protocol)) {
          desktop.open();
          const result = await anilist.receiveAuthorizationUrl(url);

          if (result instanceof ElysiaStatus) {
            await sdk.Utils.showMessageBox({
              detail: result.response.detail,
              message: "Unable to open link",
              title: identity.name,
              type: "error",
            });
          }

          return;
        }

        const opened = await torrentOpenings.stage(url, torrents);
        desktop.open();

        if (opened instanceof ElysiaStatus) {
          await sdk.Utils.showMessageBox({
            detail: opened.response.detail,
            message: "Unable to open link",
            title: identity.name,
            type: "error",
          });
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "AniList authorization was declined. Connect again when you are ready."
        ) {
          return;
        }

        await sdk.Utils.showMessageBox({
          detail: error instanceof Error ? error.message : "Unexpected error",
          message: "Unable to open link",
          title: instance.name,
          type: "error",
        });
      }
    };

    return dependencies;
  });
