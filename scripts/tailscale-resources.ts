import { cp } from "node:fs/promises";
import { join } from "node:path";

/** Ship the companion with standalone server bundles as well as the native application's copy. */
export const tailscaleResourcesPlugin: Bun.BunPlugin = {
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
          ].map((name) => cp(join(import.meta.dir, "../runtime", name), join(destination, name)))
        );
      }
    });
  },
};
