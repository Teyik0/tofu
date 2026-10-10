import { defineRoute } from "@teyik0/furin";
import { route as root } from "../root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .layout(({ children }) => (
    <main className="docs-grid" id="main">
      <aside className="docs-sidebar">
        <p>Make yourself at home</p>
        <nav aria-label="Documentation">
          <a href="/docs">Getting started</a>
          <a href="/docs/development">Development</a>
          <a href="/docs/plugins">Build a plugin</a>
          <a href="/docs/plugin-api">Plugin API</a>
          <a href="/docs/trust">Installation & trust</a>
          <a href="/docs/anilist">AniList</a>
        </nav>
        <p className="experimental">
          Plugin SDK 0.0.0
          <br />
          Experimental, local-first.
        </p>
      </aside>
      <article className="docs-article">{children}</article>
    </main>
  ));
