import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { isPreferencesPath } from "../lib/navigation";
import { settingsBackPathAtom, themeAtom } from "../state/workspace";
import type { ThemePreference } from "../types";

export function TofuStateSync({
  initialTheme,
  path,
}: {
  initialTheme: ThemePreference;
  path: string;
}) {
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const setBackPath = useSetAtom(settingsBackPathAtom);

  useEffect(() => {
    setTheme(initialTheme);
  }, [initialTheme, setTheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!isPreferencesPath(path)) {
      setBackPath(path);
    }
  }, [path, setBackPath]);

  return null;
}
