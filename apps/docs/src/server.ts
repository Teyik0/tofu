import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";

const app = new Elysia().use(await furin({ pagesDir: "./src/pages" }));

export default app;

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3040);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  app.listen({ hostname: "127.0.0.1", port });
  console.log(`Tofu documentation: http://127.0.0.1:${app.server?.port}`);
}
