import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";
import tailwind from "bun-plugin-tailwind";
import { version } from "./package.json";
import { databaseMigrationsPlugin } from "./scripts/database-migrations";

const release = process.env.TOFU_RELEASE === "1";
process.env.HUTCH_HOME ??= `${import.meta.dir}/.cache/hutch`;
if (release && process.platform === "darwin" && !process.env.ELECTROBUN_DEVELOPER_ID) {
  process.env.ELECTROBUN_DEVELOPER_ID = "-";
}

const nativeDependencies = /^(webtorrent|parse-torrent|electrobun\/main)$/;

export default defineConfig({
  desktop: defineDesktopConfig({
    app: {
      identifier: release ? "app.tofu.torrents" : "app.tofu.torrents.dev",
      name: "Tofu",
      version,
    },
    external: ["webtorrent", "parse-torrent"],
    hostEntry: "src/desktop-host.ts",
    sdk: {
      app: {
        fileAssociations: release
          ? [{ ext: ["torrent"], name: "BitTorrent document", role: "Viewer" }]
          : [],
        urlSchemes: release ? ["magnet", "tofu"] : ["tofu-dev"],
      },
      build: {
        // The host has no dependency tree; only the backend packages WebTorrent addons.
        bun: { external: ["webtorrent"] },
        copy: {
          "LICENSE.md": "bun/LICENSE.md",
          "runtime/anilist-client.json": "bun/anilist-client.json",
          "runtime/desktop-protocol.js": "bun/desktop-protocol.js",
          "src/db/drizzle": "bun/drizzle",
        },
        linux: { icon: "public/tofu-icon.png" },
        mac: {
          codesign: release || Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
          createDmg: release,
          icons: "public/tofu.iconset",
          notarize: Boolean(
            process.env.ELECTROBUN_DEVELOPER_ID &&
              process.env.ELECTROBUN_DEVELOPER_ID !== "-" &&
              process.env.ELECTROBUN_APPLEAPIKEYPATH
          ),
        },
        win: { icon: "public/tofu.iconset/icon_256x256.png" },
      },
      release: { baseUrl: "https://github.com/Teyik0/Tofu/releases/latest/download" },
    },
    window: { height: 940, width: 1400 },
  }),
  plugins: [
    databaseMigrationsPlugin,
    {
      name: tailwind.name,
      setup(builder) {
        // Furin also probes plugins with a resolver-only runtime builder.
        if ("onBeforeParse" in builder) {
          return tailwind.setup(builder);
        }
      },
    },
    {
      name: "tofu-native-dependencies",
      setup(builder) {
        builder.onResolve({ filter: nativeDependencies }, ({ path }) => ({ external: true, path }));
      },
    },
  ],
});
