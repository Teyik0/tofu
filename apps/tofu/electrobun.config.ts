import type { ElectrobunConfig } from "electrobun";
import packageJson from "./package.json";

const release = process.env.TOFU_RELEASE === "1";

export default {
  app: {
    fileAssociations: release
      ? [{ ext: ["torrent"], name: "BitTorrent document", role: "Viewer" }]
      : [],
    identifier: release ? "app.tofu.torrents" : "app.tofu.torrents.dev",
    name: "Tofu",
    urlSchemes: release ? ["magnet", "tofu"] : ["tofu-dev"],
    version: packageJson.version,
  },
  build: {
    bun: { entrypoint: ".furin/build/bun/server.js", external: ["webtorrent", "parse-torrent"] },
    copy: {
      ".furin/build/bun/client": "bun/client",
      ".furin/build/bun/public": "bun/public",
      "LICENSE.md": "bun/LICENSE.md",
      "runtime/anilist-client.json": "bun/anilist-client.json",
      "runtime/desktop-protocol.js": "bun/desktop-protocol.js",
      "runtime/node_modules": "bun/node_modules",
      "runtime/plugins": "bun/plugins",
    },
    linux: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "assets/tofu-icon.png",
    },
    mac: {
      bundleCEF: false,
      codesign: release || Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      createDmg: process.env.TOFU_RELEASE === "1",
      defaultRenderer: "native",
      icons: "assets/tofu.iconset",
      notarize: Boolean(
        process.env.ELECTROBUN_DEVELOPER_ID &&
          process.env.ELECTROBUN_DEVELOPER_ID !== "-" &&
          process.env.ELECTROBUN_APPLEAPIKEYPATH
      ),
    },
    mainProcess: "bun",
    win: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "assets/tofu.iconset/icon_256x256.png",
    },
  },
  release: { baseUrl: "https://github.com/Teyik0/Tofu/releases/latest/download" },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
