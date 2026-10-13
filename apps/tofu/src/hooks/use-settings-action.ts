import { useMutation } from "@teyik0/furin/client";
import { useSetAtom } from "jotai";
import { startTransition, useActionState, useState } from "react";
import { request } from "../components/api";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { useRefresh } from "../lib/navigation";
import { themeAtom } from "../state/workspace";

type SettingsCommand =
  | { type: "update"; settings: NonNullable<Parameters<typeof api.settings.patch>[0]> }
  | { type: "browse"; moveFiles: boolean }
  | { type: "background" }
  | { type: "default-torrent-app" };

export function useSettingsAction() {
  const updateSettings = useMutation(api.settings.patch);
  const setDefaultTorrentApp = useMutation(api.desktop.associations.torrent.post);
  const [feedback, setFeedback] = useState<string | null>(null);
  const refresh = useRefresh();
  const setTheme = useSetAtom(themeAtom);
  const saveSettings = async (patch: NonNullable<Parameters<typeof api.settings.patch>[0]>) => {
    const settings = await updateSettings.mutateAsync(patch);
    if (!settings) {
      throw new Error("Unable to update settings");
    }
    if (patch.theme !== undefined && settings && "theme" in settings) {
      startTransition(() => setTheme(settings.theme));
    }
    await refresh();
    return settings;
  };
  const [actionError, dispatchAction, busy] = useActionState<string | null, SettingsCommand>(
    async (_previous, command) => {
      setFeedback(null);
      try {
        if (command.type === "default-torrent-app") {
          const result = await setDefaultTorrentApp.mutateAsync();
          if (!(result && "torrent" in result && result.torrent)) {
            throw new Error("Unable to change the default application for .torrent files");
          }
          setFeedback("Tofu is now the default application for .torrent files.");
          return null;
        }
        if (command.type === "background") {
          await request("/desktop/background", "POST", {});
          return null;
        }
        let patch: NonNullable<Parameters<typeof api.settings.patch>[0]>;
        if (command.type === "browse") {
          const result = await request<{ path: string | null }>("/directory", "POST", undefined);
          if (!result.path) {
            return null;
          }
          patch = { downloadPath: result.path, moveFiles: command.moveFiles };
        } else {
          patch = command.settings;
        }
        await saveSettings(patch);
        return null;
      } catch (cause) {
        return errorMessage(cause, "Unable to update settings");
      }
    },
    null
  );
  return {
    busy: busy || updateSettings.isPending,
    dispatchAction,
    error: busy || updateSettings.isPending ? null : actionError,
    feedback: busy ? null : feedback,
    saveSettings,
  };
}
