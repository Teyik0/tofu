import { join } from "node:path";
import { generatePlugins } from "./plugin-packages";

await generatePlugins(join(import.meta.dir, ".."));
const { startServer } = await import("../src/server");

await startServer();
