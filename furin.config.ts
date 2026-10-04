import { defineConfig } from "@teyik0/furin/config";
import tailwind from "bun-plugin-tailwind";

const nativeDependencies = /^(webtorrent|parse-torrent|electrobun\/main)$/;

export default defineConfig({
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
