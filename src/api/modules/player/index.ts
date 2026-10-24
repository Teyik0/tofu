import { existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { Elysia, problem, t } from "elysia";
import { useLogger } from "evlog/elysia";
import { version } from "libvlc-wasm/package.json";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { sanitizeLog } from "../../lib/diagnostics";
import { accessPlugin } from "../access/plugin";

// Builds copy the engine next to the server bundle; development and tests run from the project
// root and read it from node_modules.
const bundled = join(import.meta.dir, "libvlc-wasm");
const engineRoot = existsSync(bundled)
  ? bundled
  : dirname(Bun.resolveSync("libvlc-wasm/package.json", process.cwd()));
// The version in the URL changes with each engine release.
const cacheControl = "private, max-age=31536000, immutable";

export const playerPlugin = new Elysia({ name: "tofu-player-api" })
  .use(accessPlugin)
  .use(databasePlugin)
  .guard({ personal: true })
  .post(
    "/player/diagnostics",
    {
      body: t.Object({
        audioState: t.String({ maxLength: 32 }),
        buffering: t.Number({ maximum: 1, minimum: 0 }),
        engineMessages: t.Array(t.String({ maxLength: 1024 }), { maxItems: 8 }),
        fileIndex: t.Integer({ minimum: 0 }),
        message: t.String({ maxLength: 2048 }),
        operation: t.Union([
          t.Literal("start"),
          t.Literal("play"),
          t.Literal("pause"),
          t.Literal("engine"),
          t.Literal("media"),
        ]),
        playbackState: t.String({ maxLength: 32 }),
        time: t.Number({ minimum: 0 }),
        torrentId: t.String({ maxLength: 64 }),
      }),
    },
    ({ body }) => {
      const { message, operation, ...context } = body;
      const log = useLogger();
      log.set({
        component: "player",
        context: { ...context, engineVersion: version },
        dataDir: instance.dataDir,
        error: sanitizeLog({ message }),
        operation,
      });
      log.setLevel("error");
      return { ok: true };
    }
  )
  .guard({
    transform({ set }) {
      // The engine's workers must remain cross-origin isolated as well as the document.
      set.headers["cross-origin-embedder-policy"] = "require-corp";
      set.headers["cross-origin-resource-policy"] = "same-origin";
    },
  })
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
