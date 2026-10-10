import { useMutation } from "@teyik0/furin/client";
import { useSetAtom } from "jotai";
import { startTransition, useActionState } from "react";
import { request } from "../components/api";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import { themeAtom } from "../state/workspace";

type SettingsCommand =
  | { type: "update"; settings: NonNullable<Parameters<typeof api.settings.patch>[0]> }
  | { type: "browse"; moveFiles: boolean }
  | { type: "background" };

export function useSettingsAction() {
  const updateSettings = useMutation(api.settings.patch);
  const refresh = useRefresh();
  const setTheme = useSetAtom(themeAtom);
  const [actionError, dispatchAction, busy] = useActionState<string | null, SettingsCommand>(
    async (_previous, command) => {
      try {
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
        const settings = await updateSettings.mutateAsync(patch);
        if (patch.theme !== undefined && settings && "theme" in settings) {
          startTransition(() => setTheme(settings.theme));
        }
        await refresh();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Unable to update settings";
      }
    },
    null
  );
  return { busy, dispatchAction, error: busy ? null : actionError };
}
