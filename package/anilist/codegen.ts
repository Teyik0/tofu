import type { CodegenConfig } from "@graphql-codegen/cli";

const config = {
  documents: "src/server/graphql/operations.graphql",
  generates: {
    "src/server/graphql/generated.ts": {
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
  schema: "src/server/graphql/schema.graphql",
} satisfies CodegenConfig;

export default config;
