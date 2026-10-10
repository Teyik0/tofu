import { useEffect } from "react";
import { applyTheme } from "../theme";
import type { ThemePreference } from "../types";

export function useTheme(theme: ThemePreference) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(theme);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
}
