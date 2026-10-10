import { expect, test } from "bun:test";
import { Provider, useAtomValue } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { createTofuStore, selectedTorrentAtom, themeAtom } from "../src/state/workspace";
import type { ThemePreference } from "../src/types";

function Appearance() {
  const theme = useAtomValue(themeAtom);
  return <span>{theme}</span>;
}

test.each(["system", "light", "dark"] satisfies ThemePreference[])(
  "the workspace exposes the saved %s appearance during server rendering",
  (theme) => {
    expect(
      renderToStaticMarkup(
        <Provider store={createTofuStore(theme)}>
          <Appearance />
        </Provider>
      )
    ).toBe(`<span>${theme}</span>`);
  }
);

test("separate workspaces do not share appearance or selection", () => {
  const first = createTofuStore("dark");
  const second = createTofuStore("light");
  first.set(selectedTorrentAtom, "first-torrent");
  first.set(themeAtom, "system");
  expect(second.get(selectedTorrentAtom)).toBeNull();
  expect(second.get(themeAtom)).toBe("light");
});
