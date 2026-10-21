import type { CodegenConfig } from "@graphql-codegen/cli";

const config = {
  documents: "src/api/modules/anilist/graphql/operations.graphql",
  generates: {
    "src/api/modules/anilist/graphql/generated.ts": {
      config: {
        avoidOptionals: { field: true, inputValue: false },
        documentMode: "documentNode",
        enumsAsTypes: true,
        scalars: { CountryCode: "string", FuzzyDateInt: "number", Json: "unknown" },
        skipTypename: true,
        strictScalars: true,
        useTypeImports: true,
      },
      plugins: ["typescript-operations", "typescript-generic-sdk"],
    },
    "src/api/modules/anilist/graphql/schema.graphql": {
      plugins: ["schema-ast"],
    },
  },
  schema: "https://graphql.anilist.co",
} satisfies CodegenConfig;

export default config;
