import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a clean checkout generates the AniList SDK and route declarations before type checking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-codegen-"));
  const graphqlPath = "src/api/modules/anilist/graphql";
  const snapshot = join(import.meta.dir, "..", graphqlPath);
  const source = (await Bun.file(join(snapshot, "schema-source.json")).json()) as {
    sha256: string;
  };
  expect(Bun.SHA256.hash(await Bun.file(join(snapshot, "schema.graphql")).text(), "hex")).toBe(
    source.sha256
  );
  await symlink(
    join(import.meta.dir, "../node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await mkdir(join(directory, graphqlPath), { recursive: true });
  await Promise.all(
    ["schema.graphql", "operations.graphql"].map((file) =>
      cp(join(snapshot, file), join(directory, graphqlPath, file))
    )
  );
  await mkdir(join(directory, "scripts"));
  await Promise.all(
    [
      "package.json",
      "codegen.ts",
      "biome.jsonc",
      "bunfig.toml",
      ".gitignore",
      "scripts/anilist-codegen.ts",
      "scripts/route-types.ts",
    ].map((file) => cp(join(import.meta.dir, "..", file), join(directory, file)))
  );
  await Bun.write(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        jsx: "react-jsx",
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ESNext",
        types: ["bun"],
      },
      include: ["src", "furin-env.d.ts"],
    })
  );
  await mkdir(join(directory, "src/pages"));
  await Bun.write(
    join(directory, "src/pages/root.tsx"),
    'import { defineRootRoute } from "@teyik0/furin";\nexport const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);\n'
  );
  await Bun.write(
    join(directory, "src/pages/index.tsx"),
    'import { defineRoute } from "@teyik0/furin";\nimport { route as root } from "./root";\nexport const route = defineRoute().config({ layout: root, mode: "ssr" }).loader(() => ({ title: "Catalog" })).page(() => null);\n'
  );
  await Bun.write(
    join(directory, "src/check.ts"),
    'import { getRouteApi } from "@teyik0/furin/client";\nimport type { CatalogQueryVariables } from "./api/modules/anilist/graphql/generated";\nexport const variables: CatalogQueryVariables = { page: 1 };\nexport const readTitle = (): string => getRouteApi("/").useLoaderData().title;\n'
  );
  const run = (script: string) => {
    const child = Bun.spawn([process.execPath, "run", script], {
      cwd: directory,
      stderr: "pipe",
      stdout: "pipe",
    });
    return Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([code, output, error]) => [code, `${output}\n${error}`] as const);
  };
  try {
    expect(await Bun.file(join(directory, graphqlPath, "generated.ts")).exists()).toBe(false);
    expect(await Bun.file(join(directory, "furin-env.d.ts")).exists()).toBe(false);
    const [validExit, validError] = await run("tscheck");
    expect(validExit, validError).toBe(0);
    const output = await Bun.file(join(directory, graphqlPath, "generated.ts")).text();
    const modifiedAt = (await stat(join(directory, graphqlPath, "generated.ts"))).mtimeMs;
    expect((await run("codegen"))[0]).toBe(0);
    expect(await Bun.file(join(directory, graphqlPath, "generated.ts")).text()).toBe(output);
    expect((await stat(join(directory, graphqlPath, "generated.ts"))).mtimeMs).toBe(modifiedAt);
    expect((await run("codegen:check"))[0]).toBe(0);
    await Bun.write(join(directory, graphqlPath, "generated.ts"), "// Stale SDK\n");
    const [staleExit, staleError] = await run("codegen:check");
    expect(staleExit).not.toBe(0);
    expect(staleError).toContain("The AniList SDK is stale");
    await Bun.write(
      join(directory, graphqlPath, "operations.graphql"),
      "query Invalid { Viewer { tofuUnknownField } }\n"
    );
    const [exit, error] = await run("tscheck");
    expect(exit).not.toBe(0);
    expect(error).toContain("tofuUnknownField");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
