import { defineRoute } from "@teyik0/furin";
import { Callout, Code, DocTitle } from "../../components/docs";

export const route = defineRoute("/docs/development")
  .config({ mode: "ssr" })
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
        Use Bun 1.4.3 or newer. On macOS, install Xcode Command Line Tools. Linux needs GTK 3,
        WebKitGTK 4.1, Ayatana AppIndicator, and librsvg. Install the matching system packages
        before building the native app.
      </p>
      <Code>{`git clone https://github.com/Teyik0/Tofu.git
cd Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop`}</Code>
      <p>
        Run these commands from the repository root. <code>setup</code> prepares native addons and
        application resources.
        <code>build:desktop</code> prepares the Electrobun SDK through Hutch. <code>prepare</code>
        installs the Git hooks.
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
bun run dev:web

# Native development app with HMR
bun run dev

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
        <code>apps/tofu/src/api/index.ts</code> exports the shared <code>apiPlugin</code> Elysia
        application. It installs the desktop host first and composes route plugins under{" "}
        <code>/api</code>. <code>src/server.ts</code> attaches Furin to that same instance and owns
        listening and shutdown. Required services initialize before the app starts listening.
      </p>
      <p>
        Loaders read typed endpoints through <code>apps/tofu/src/lib/client.ts</code>. On the
        server, <code>treaty(apiPlugin).api</code> dispatches directly to the application. In the
        browser, the client uses the current origin with credentials and no-store caching. Handle
        each Eden response’s <code>error</code> directly in the loader before returning its{" "}
        <code>data</code>.
      </p>
      <p>
        The automation service persists rules and typed decisions. The separate{" "}
        <code>releaseAutomation</code> integration collects releases, schedules checks, and executes
        downloads. AniList owns its service in <code>package/anilist</code> and receives typed
        options for these host capabilities and the shared database transaction.
      </p>
      <p>
        This keeps downloads and credentials on the Bun side and lets background mode remove the
        WebView while transfers continue. A second engine or an embedded external site would split
        download state and lifecycle ownership.
      </p>
      <Callout>
        <p>
          The workspace pins Furin preview <code>420af31</code> and Furin Electrobun preview{" "}
          <code>420af31</code> in <code>vendor</code>. Use its checked-in archives and the root
          dependency catalog. WebTorrent addons stay external to the native bundle; the tracker/wire
          bridge depends on WebTorrent 3.0.21.
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
        Keep repository text in English. Shared domain contracts live in{" "}
        <code>package/plugins/src/domain.ts</code> and are reexported by{" "}
        <code>package/plugins/src/domain.ts</code>. Development and release profiles use separate
        data directories; restart the Bun process after changing profile or engine environment
        variables.
      </p>
    </>
  ));
