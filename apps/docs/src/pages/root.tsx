import "../styles.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { Brand } from "../components/brand";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <meta
          content="A considered desktop torrent client. Built with Bun, made your own with plugins."
          name="description"
        />
        <meta content="#f5f3e9" name="theme-color" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <link href="/public/favicon.svg" rel="icon" type="image/svg+xml" />
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="site-shell">
          <header className="site-header">
            <a aria-label="Tofu home" className="brand" href="/">
              <Brand />
              tofu<span className="brand-period">.</span>
            </a>
            <nav aria-label="Main navigation">
              <a href="/docs">Documentation</a>
              <a href="https://github.com/Teyik0/Tofu">
                GitHub <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </header>
          {children}
          <footer className="site-footer">
            <span>A little less noise. A little more tofu.</span>
            <div>
              <a href="https://github.com/Teyik0/Tofu/blob/main/LICENSE.md">MIT license</a>
              <span>
                Made by <a href="https://github.com/Teyik0">teyik0</a>
              </span>
            </div>
          </footer>
        </div>
        <Scripts />
      </body>
    </html>
  ));
