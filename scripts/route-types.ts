import { join } from "node:path";
import { writeRouteTypes } from "@teyik0/furin/build";

// The pinned preview only emits route types in development; reuse its scanner and writer.
const discovery = new URL("./server/router/discovery.ts", import.meta.resolve("@teyik0/furin"));
const {
  scanPages,
}: {
  scanPages: (pagesDir: string) => Promise<{ routes: Parameters<typeof writeRouteTypes>[0] }>;
} = await import(discovery.href);
const root = join(import.meta.dir, "..");
const { routes } = await scanPages(join(root, "src/pages"));
writeRouteTypes(routes, root);
