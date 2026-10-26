import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "tofu-build-"));
await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => rm(directory, { force: true, recursive: true }));

// Elysia AOT evaluates the API; its resources must never use live application storage.
const build = Bun.spawn(
  [process.execPath, "--bun", "run", "furin-electrobun", "build", "--env=dev"],
  {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      DATABASE_URL: join(directory, "tofu.sqlite"),
      FURIN_APP_DATA_DIR: join(directory, "data"),
      TOFU_PROFILE: "dev",
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }
);
process.exitCode = await build.exited;
