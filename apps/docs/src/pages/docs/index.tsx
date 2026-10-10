import { defineRoute } from "@teyik0/furin";
import { Callout, DocTitle } from "../../components/docs";
import { route as docs } from "./_route";

export const route = defineRoute()
  .config({ layout: docs, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Getting started — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="A small, comfortable home for your downloads. Start here, then make it yours."
        label="The essentials"
        title="Meet Tofu."
      />
      <h2>Install the desktop app</h2>
      <p>
        Get the installer for your platform from{" "}
        <a href="https://github.com/Teyik0/Tofu/releases">GitHub Releases</a>. Tofu is free and open
        source.
      </p>
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th>Install</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>macOS Apple Silicon</td>
            <td>Open the DMG and move Tofu to Applications.</td>
          </tr>
          <tr>
            <td>Windows x64</td>
            <td>
              Extract the entire ZIP, then run <code>Tofu-Setup.exe</code> beside its{" "}
              <code>.installer</code> folder.
            </td>
          </tr>
          <tr>
            <td>Linux x64 / ARM64</td>
            <td>
              Extract the archive and run <code>./installer</code>.
            </td>
          </tr>
        </tbody>
      </table>
      <Callout>
        <p>
          macOS Apple Silicon is the currently validated platform. Windows and Linux targets need
          their own native validation. Read the{" "}
          <a href="https://github.com/Teyik0/Tofu/blob/main/docs/releases.md">release guide</a> for
          signing, first-launch approval, and updates.
        </p>
      </Callout>
      <h2>Your first download</h2>
      <ol>
        <li>
          Add a magnet link, torrent URL, or <code>.torrent</code> file. You can also drop a torrent
          into the window.
        </li>
        <li>
          Choose a thread and destination folder. Threads keep separate collections of downloads
          together.
        </li>
        <li>Open a torrent for file priorities, trackers, and live transfer details.</li>
      </ol>
      <p>
        Pause and resume whenever you need. Downloaded files stay on disk unless you explicitly
        choose the deletion option. Unknown statistics appear as <code>—</code>.
      </p>
      <h2>A little more your own</h2>
      <p>
        Enable optional integrations from <strong>Plugins</strong> in the sidebar. Discovery sources
        help find releases; AniList connects your anime library; automation rules follow releases
        you approve.
      </p>
      <p>
        In Preferences, enable background mode to keep transfers running after closing the window.
        The menu bar icon brings Tofu back or quits it completely.
      </p>
      <div className="doc-links">
        <a href="/docs/development">
          <strong>Run from source →</strong>
          <span>The Bun workspace, native builds, and checks.</span>
        </a>
        <a href="/docs/plugins">
          <strong>Build a plugin →</strong>
          <span>A typed API and a place in the native UI.</span>
        </a>
      </div>
    </>
  ));
