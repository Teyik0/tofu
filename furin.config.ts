import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";
import tailwind from "bun-plugin-tailwind";
import { version } from "./package.json";

const release = process.env.NODE_ENV === "production";
process.env.HUTCH_HOME ??= `${import.meta.dir}/.cache/hutch`;
if (release && process.platform === "darwin" && !process.env.ELECTROBUN_DEVELOPER_ID) {
  // The "-" identity enables free ad hoc signing without an Apple Developer account.
  process.env.ELECTROBUN_DEVELOPER_ID = "-";
}

const nativeDependencies = /^(webtorrent|parse-torrent|electrobun\/main)$/;

export default defineConfig({
  desktop: defineDesktopConfig({
    app: {
      fileAssociations: release
        ? [{ ext: ["torrent"], name: "BitTorrent document", role: "Viewer" }]
        : [],
      identifier: release ? "app.tofu.torrents" : "app.tofu.torrents.dev",
      name: "Tofu",
      urlSchemes: release ? ["magnet", "tofu"] : ["tofu-dev"],
      version,
    },
    build: {
      // Native integrations use the same SDK as the managed host.
      bun: { entrypoint: "src/desktop.ts", external: ["webtorrent"] },
      copy: {
        [process.platform === "win32" ? "runtime/tofu-tsnet.exe" : "runtime/tofu-tsnet"]:
          process.platform === "win32" ? "bun/tofu-tsnet.exe" : "bun/tofu-tsnet",
        "LICENSE.md": "bun/LICENSE.md",
        "public/icon.png": "bun/tray-icon.png",
        "public/tray-template.png": "bun/tray-template.png",
        "runtime/anilist-client.json": "bun/anilist-client.json",
        "runtime/tofu-tsnet.licenses.txt": "bun/tofu-tsnet.licenses.txt",
        "runtime/tofu-tsnet.manifest.json": "bun/tofu-tsnet.manifest.json",
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
    dataDir: {
      developmentName: "Tofu-dev",
      name: "Tofu",
    },
    external: ["webtorrent", "parse-torrent"],
    protocols: [release ? "tofu" : "tofu-dev"],
    release: { baseUrl: "https://github.com/Teyik0/Tofu/releases/latest/download" },
  }),
  pagesDir: "./src/pages",
  plugins: [
    {
      name: "tofu-database-migrations",
      setup(builder) {
        // Furin also probes plugins with a resolver-only runtime builder.
        if (!("onEnd" in builder) || builder.config.target !== "bun" || !builder.config.outdir) {
          return;
        }
        const destination = join(builder.config.outdir, "drizzle");
        builder.onEnd(async (result) => {
          if (result.success) {
            await cp(join(import.meta.dir, "src/db/drizzle"), destination, { recursive: true });
          }
        });
      },
    },
    {
      name: "tofu-player-engine",
      setup(builder) {
        // Furin also probes plugins with a resolver-only runtime builder. Only the server bundle
        // serves the engine; React Server Component graphs never load it.
        if (
          !("onEnd" in builder) ||
          builder.config.target !== "bun" ||
          !builder.config.outdir ||
          builder.config.conditions?.includes("react-server")
        ) {
          return;
        }
        const engine = dirname(Bun.resolveSync("libvlc-wasm/package.json", import.meta.dir));
        const destination = join(builder.config.outdir, "libvlc-wasm");
        builder.onEnd(async (result) => {
          if (result.success) {
            await Promise.all(
              ["COPYING", "LICENSE", "fonts", "package.json", "src", "wasm"].map((entry) =>
                cp(join(engine, entry), join(destination, entry), { recursive: true })
              )
            );
          }
        });
      },
    },
    {
      name: "tofu-tailscale-resources",
      setup(builder) {
        if (
          !("onEnd" in builder) ||
          builder.config.target !== "bun" ||
          !builder.config.outdir ||
          builder.config.conditions?.includes("react-server")
        ) {
          return;
        }
        const destination = builder.config.outdir;
        builder.onEnd(async (result) => {
          if (result.success) {
            await Promise.all(
              [
                process.platform === "win32" ? "tofu-tsnet.exe" : "tofu-tsnet",
                "tofu-tsnet.licenses.txt",
                "tofu-tsnet.manifest.json",
              ].map((name) => cp(join(import.meta.dir, "runtime", name), join(destination, name)))
            );
          }
        });
      },
    },
    {
      name: tailwind.name,
      setup(builder) {
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
