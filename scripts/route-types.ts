import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRouteTypes } from "@teyik0/furin/build";

if (process.argv[2] === "--scan") {
  await generateRouteTypes({ pagesDir: "./src/pages", rootDir: `${import.meta.dir}/..` });
  // Route imports can open workers without starting Elysia. End this isolated scan process.
  process.exit(0);
} else {
  const scratch = await mkdtemp(join(tmpdir(), "tofu-route-types-"));
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--scan"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TOFU_DATA_DIR: join(scratch, "data"),
        TOFU_DOWNLOAD_DIR: join(scratch, "downloads"),
      },
      stderr: "inherit",
      stdout: "inherit",
    });
    process.exitCode = await child.exited;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}
