import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";
import tailwind from "bun-plugin-tailwind";
import native from "./electrobun.config";

const nativeDependencies = /^(webtorrent|parse-torrent|electrobun\/main)$/;

export default defineConfig({
  desktop: defineDesktopConfig({
    app: { identifier: native.app.identifier, name: native.app.name, version: native.app.version },
    external: ["webtorrent", "parse-torrent"],
    hostEntry: "src/desktop-host.ts",
    sdk: {
      app: { fileAssociations: native.app.fileAssociations, urlSchemes: native.app.urlSchemes },
      build: {
        bun: { external: ["webtorrent", "parse-torrent"] },
        copy: {
          "LICENSE.md": "bun/LICENSE.md",
          "runtime/anilist-client.json": "bun/anilist-client.json",
          "runtime/desktop-protocol.js": "bun/desktop-protocol.js",
          "runtime/node_modules": "bun/node_modules",
        },
        linux: native.build.linux,
        mac: native.build.mac,
        win: native.build.win,
      },
      release: native.release,
    },
    window: { height: 940, width: 1400 },
  }),
  plugins: [
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
