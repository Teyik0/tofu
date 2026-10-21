import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRouteTypes } from "@teyik0/furin/build";

// Scanning imports the route modules, which open Tofu's runtime resources; release them so the process exits.
const scratch = await mkdtemp(join(tmpdir(), "tofu-route-types-"));
process.env.TOFU_DATA_DIR = join(scratch, "data");
process.env.TOFU_DOWNLOAD_DIR = join(scratch, "downloads");
try {
  await generateRouteTypes({ pagesDir: "./src/pages", rootDir: `${import.meta.dir}/..` });
} finally {
  try {
    const { stopServices } = await import("../src/api/lib/lifecycle");
    await stopServices();
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}
