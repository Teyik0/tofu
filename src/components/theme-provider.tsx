import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { ThemePreference } from "../types";

interface ThemeContextValue {
  setTheme: (theme: ThemePreference) => void;
  theme: ThemePreference;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: ReactNode;
  initialTheme: ThemePreference;
}) {
  const [theme, setTheme] = useState(initialTheme);

  // Sync can update the saved preference from another window.
  useEffect(() => setTheme(initialTheme), [initialTheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <ThemeContext.Provider value={{ setTheme, theme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
