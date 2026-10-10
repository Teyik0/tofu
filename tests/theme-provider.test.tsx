import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider, useTheme } from "../src/components/theme-provider";
import type { ThemePreference } from "../src/types";

function Appearance() {
  const { theme } = useTheme();
  return <span>{theme}</span>;
}

test.each(["system", "light", "dark"] satisfies ThemePreference[])(
  "the theme provider exposes the saved %s appearance during server rendering",
  (theme) => {
    expect(
      renderToStaticMarkup(
        <ThemeProvider initialTheme={theme}>
          <Appearance />
        </ThemeProvider>
      )
    ).toBe(`<span>${theme}</span>`);
  }
);
