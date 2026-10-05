import type { ThemePreference } from "./types";

export function applyTheme(theme: ThemePreference) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", dark);
}

// Resolve system appearance before the first paint, including native WebViews.
export const themeBootstrap = `(() => {
  const root = document.documentElement;
  root.classList.toggle("dark", root.dataset.theme === "dark" ||
    (root.dataset.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
})();`;
