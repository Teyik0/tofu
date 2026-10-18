import { existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { Elysia, problem } from "elysia";
import { version } from "libvlc-wasm/package.json";

// Builds copy the engine next to the server bundle; development and tests run from the project
// root and read it from node_modules.
const bundled = join(import.meta.dir, "libvlc-wasm");
const engineRoot = existsSync(bundled)
  ? bundled
  : dirname(Bun.resolveSync("libvlc-wasm/package.json", process.cwd()));
// The version in the URL changes with each engine release.
const cacheControl = "public, max-age=31536000, immutable";

export const playerPlugin = new Elysia({ name: "tofu-player-api" })
  // The engine reads fonts as lazy files, which first ask for their size with HEAD.
  .head("/player/engine/:version/*", async ({ params }) => {
    const path = normalize(join(engineRoot, params["*"]));
    const file = Bun.file(path);
    if (
      params.version !== version ||
      !path.startsWith(engineRoot + sep) ||
      !(await file.exists())
    ) {
      return problem(404, { detail: "Player file not found" });
    }
    return new Response(null, {
      headers: {
        "cache-control": cacheControl,
        "content-length": String(file.size),
        "content-type": file.type,
      },
    });
  })
  .get("/player/engine/:version/*", async ({ params }) => {
    const path = normalize(join(engineRoot, params["*"]));
    const file = Bun.file(path);
    if (
      params.version !== version ||
      !path.startsWith(engineRoot + sep) ||
      !(await file.exists())
    ) {
      return problem(404, { detail: "Player file not found" });
    }
    return new Response(file, { headers: { "cache-control": cacheControl } });
  });
