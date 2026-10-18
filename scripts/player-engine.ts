import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";

const engine = dirname(Bun.resolveSync("libvlc-wasm/package.json", import.meta.dir));

/** Copies the player's VLC engine next to the server bundle, which serves it to the player page. */
export const playerEnginePlugin: Bun.BunPlugin = {
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
};
