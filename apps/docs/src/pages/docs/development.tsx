import { defineRoute } from "@teyik0/furin";
import { Callout, Code, DocTitle } from "../../components/docs";
import { route as docs } from "./_route";

export const route = defineRoute()
  .config({ layout: docs, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Development — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="One Bun workspace. A desktop app, a documentation site, and packages you can build on."
        label="From source"
        title="Settle in."
      />
      <h2>Set up the workspace</h2>
      <p>
        Use Bun 1.4.2 or newer. On macOS, install Xcode Command Line Tools. Linux needs GTK 3,
        WebKitGTK 4.1, Ayatana AppIndicator, and librsvg. The{" "}
        <a href="https://github.com/Teyik0/Tofu/blob/main/docs/development.md">
          native development guide
        </a>{" "}
        lists platform prerequisites.
      </p>
      <Code>{`git clone https://github.com/Teyik0/Tofu.git
cd Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop`}</Code>
      <p>
        Run these commands from the repository root. <code>setup</code> prepares the Hutch devkit
        used by Electrobun. <code>prepare</code> installs the Git hooks.
      </p>
      <h2>Choose your workspace</h2>
      <table>
        <thead>
          <tr>
            <th>Directory</th>
            <th>Responsibility</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>apps/tofu</code>
            </td>
            <td>Desktop UI, Bun API, WebTorrent engine, native lifecycle.</td>
          </tr>
          <tr>
            <td>
              <code>apps/docs</code>
            </td>
            <td>This Furin documentation site.</td>
          </tr>
          <tr>
            <td>
              <code>apps/scaffolder</code>
            </td>
            <td>Local plugin generator.</td>
          </tr>
          <tr>
            <td>
              <code>package/plugins</code>
            </td>
            <td>Experimental SDK, contracts, settings, authentication, and runtime.</td>
          </tr>
          <tr>
            <td>
              <code>package/anilist</code>
            </td>
            <td>The official AniList plugin.</td>
          </tr>
          <tr>
            <td>
              <code>package/ui</code>
            </td>
            <td>Shared UI components.</td>
          </tr>
        </tbody>
      </table>
      <Code>{`# Desktop web UI: http://127.0.0.1:3030
bun run dev

# Native development app
bun run dev:desktop

# Documentation: http://127.0.0.1:3040
bun run dev:docs

# Build a single workspace
bun run --filter @tofu/docs build`}</Code>
      <h2>The architecture</h2>
      <p>
        React pages use Furin routes and loaders. Elysia serves their API. A single WebTorrent
        engine runs in Bun, and Electrobun supplies the native window. Plugins consume host
        capabilities through a typed Elysia facade and share the host layout.
      </p>
      <p>
        This keeps downloads and credentials on the Bun side and lets background mode remove the
        WebView while transfers continue. A second engine or an embedded external site would split
        download state and lifecycle ownership.
      </p>
      <Callout>
        <p>
          The workspace pins a local Furin preview in <code>vendor</code>. Use its checked-in
          archives and the root dependency catalog. WebTorrent addons stay external to the native
          bundle; the tracker/wire bridge depends on WebTorrent 3.0.21.
        </p>
      </Callout>
      <h2>Check your changes</h2>
      <Code>{`bun run tscheck
bun run fix
bun run test
bun run build:desktop
bun run test:native`}</Code>
      <p>
        Transfer and lifecycle tests use public APIs, real peers, and temporary directories. Native
        checks need a graphical session. Test script injection is opt-in through{" "}
        <code>TOFU_SMOKE_SCRIPT</code>; regular launches never inject it.
      </p>
      <p>
        Keep repository text in English and shared desktop domain types in{" "}
        <code>apps/tofu/src/types.ts</code>. Development and release profiles use separate data
        directories; restart the Bun process after changing profile or engine environment variables.
      </p>
    </>
  ));
