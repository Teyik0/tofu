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
  },
  schema: "src/api/modules/anilist/graphql/schema.graphql",
} satisfies CodegenConfig;

export default config;
