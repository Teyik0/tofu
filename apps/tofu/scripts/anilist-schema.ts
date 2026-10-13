import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  lexicographicSortSchema,
  printSchema,
} from "graphql";

const endpoint = "https://graphql.anilist.co";
const response = await fetch(endpoint, {
  body: JSON.stringify({ query: getIntrospectionQuery() }),
  headers: { "content-type": "application/json" },
  method: "POST",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`AniList schema download failed (HTTP ${response.status})`);
}
const result = (await response.json()) as {
  data?: IntrospectionQuery;
  errors?: { message: string }[];
};
if (!result.data || result.errors?.length) {
  throw new Error("AniList did not return a complete introspection schema");
}
const schema = `${printSchema(lexicographicSortSchema(buildClientSchema(result.data)))}\n`;
const directory = join(import.meta.dir, "../src/api/modules/anilist/graphql");
await mkdir(directory, { recursive: true });
await Bun.write(join(directory, "schema.graphql"), schema);
await Bun.write(
  join(directory, "schema-source.json"),
  `${JSON.stringify({ endpoint, fetchedAt: new Date().toISOString(), sha256: Bun.SHA256.hash(schema, "hex") }, null, 2)}\n`
);
console.log("Updated the AniList schema snapshot. Review it and run bun run codegen.");
