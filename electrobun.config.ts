import type { ElectrobunConfig } from "electrobun";
import { version } from "./package.json";

export default {
  app: { identifier: "app.tofu.torrents", name: "Tofu", version },
  build: {
    bun: { entrypoint: ".furin/build/bun/server.js", external: ["webtorrent", "parse-torrent"] },
    copy: {
      ".furin/build/bun/client": "bun/client",
      ".furin/build/bun/public": "bun/public",
      "LICENSE.md": "bun/LICENSE.md",
      "runtime/node_modules": "bun/node_modules",
    },
    mac: {
      bundleCEF: false,
      codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      createDmg: process.env.TOFU_RELEASE === "1",
      defaultRenderer: "native",
      icons: "assets/tofu.iconset",
      notarize: Boolean(
        process.env.ELECTROBUN_DEVELOPER_ID && process.env.ELECTROBUN_APPLEAPIKEYPATH
      ),
    },
    mainProcess: "bun",
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
