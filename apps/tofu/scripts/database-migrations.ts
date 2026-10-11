import { cp } from "node:fs/promises";
import { join } from "node:path";

export const databaseMigrationsPlugin: Bun.BunPlugin = {
  name: "tofu-database-migrations",
  setup(builder) {
    // Furin also probes plugins with a resolver-only runtime builder.
    if (!("onEnd" in builder) || builder.config.target !== "bun" || !builder.config.outdir) {
      return;
    }
    const destination = join(builder.config.outdir, "drizzle");
    builder.onEnd(async (result) => {
      if (result.success) {
        await cp(join(import.meta.dir, "../src/db/drizzle"), destination, { recursive: true });
      }
    });
  },
};
