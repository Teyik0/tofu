import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const pluginIdPattern = /^[a-z][a-z0-9-]*$/;
const templateSuffixPattern = /\.template$/;

export interface ScaffoldOptions {
  destination: string;
  furin?: string;
  name?: string;
  sdk?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function scaffold(
  options: ScaffoldOptions
): Promise<{ name: string; directory: string }> {
  const directory = resolve(options.destination);
  if (await exists(directory)) {
    throw new Error(`The project directory already exists: ${directory}`);
  }
  const name = options.name ?? basename(directory);
  if (!pluginIdPattern.test(name) || name.length > 100) {
    throw new Error(
      "Plugin IDs must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (up to 100 characters)"
    );
  }
  const root = resolve(import.meta.dir, "../../..");
  const sdk = resolve(options.sdk ?? join(root, "package/plugins"));
  const furin = resolve(options.furin ?? join(root, "vendor/furin-pr163-914e82a.tgz"));
  const sdkManifest: unknown = await Bun.file(join(sdk, "package.json")).json();
  if (
    !sdkManifest ||
    typeof sdkManifest !== "object" ||
    !("name" in sdkManifest) ||
    sdkManifest.name !== "@tofu/plugins" ||
    !("version" in sdkManifest) ||
    sdkManifest.version !== "0.0.0" ||
    !("exports" in sdkManifest) ||
    !sdkManifest.exports ||
    typeof sdkManifest.exports !== "object"
  ) {
    throw new Error("--sdk must point to a local @tofu/plugins package");
  }
  if (!(await Bun.file(furin).exists())) {
    throw new Error("--furin must point to an existing local Furin tarball");
  }
  const workspace = (await Bun.file(join(root, "package.json")).json()) as {
    catalog: {
      elysia: string;
      react: string;
      typebox: string;
      "@elysia/eden": string;
      "@types/bun": string;
      "@types/react": string;
      typescript: string;
    };
  };
  const manifest = {
    dependencies: {
      "@teyik0/furin": "file:./.tofu-vendor/furin.tgz",
      "@tofu/plugins": "file:./.tofu-sdk",
      elysia: workspace.catalog.elysia,
      react: workspace.catalog.react,
      typebox: workspace.catalog.typebox,
    },
    devDependencies: {
      "@types/bun": workspace.catalog["@types/bun"],
      "@types/react": workspace.catalog["@types/react"],
      typescript: workspace.catalog.typescript,
    },
    exports: { "./client": "./src/client/index.tsx", "./server": "./src/server/index.ts" },
    files: ["src", "dist/server", "README.md"],
    name: `tofu-plugin-${name}`,
    overrides: { "@elysia/eden": workspace.catalog["@elysia/eden"] },
    private: true,
    scripts: {
      build:
        "bun build src/server/index.ts --target=bun --packages=external --outdir=dist/server && bun build src/client/index.tsx --target=browser --packages=external --outdir=dist/client && bun x --no-install furin build",
      dev: "bun --hot dev/server.ts",
      test: "bun test tests",
      tscheck: "tsc --noEmit",
    },
    tofuPlugin: {
      apiVersion: "0.0.0",
      client: "./src/client/index.tsx",
      id: name,
      server: "./dist/server/index.js",
    },
    type: "module",
    version: "0.0.0",
  };
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  await mkdir(join(directory, ".tofu-vendor"));
  await Bun.write(join(directory, ".tofu-vendor/furin.tgz"), Bun.file(furin));
  const portableSDK = join(directory, ".tofu-sdk");
  await mkdir(portableSDK);
  await copySDKSource(join(sdk, "src"), join(portableSDK, "src"));
  await Bun.write(
    join(portableSDK, "package.json"),
    JSON.stringify(
      {
        dependencies: {
          "@teyik0/furin": "file:../.tofu-vendor/furin.tgz",
          elysia: workspace.catalog.elysia,
          react: workspace.catalog.react,
          typebox: workspace.catalog.typebox,
        },
        exports: sdkManifest.exports,
        name: "@tofu/plugins",
        type: "module",
        version: "0.0.0",
      },
      null,
      2
    )
  );
  await copyTemplates(resolve(import.meta.dir, "../templates"), directory, name);
  await Bun.write(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, name };
}

async function copyTemplates(source: string, destination: string, name: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const target = join(destination, entry.name.replace(templateSuffixPattern, ""));
      if (entry.isDirectory()) {
        await mkdir(target);
        await copyTemplates(join(source, entry.name), target, name);
      } else if (entry.isFile()) {
        await Bun.write(
          target,
          (await Bun.file(join(source, entry.name)).text()).replaceAll("{{id}}", name)
        );
      }
    })
  );
}

async function copySDKSource(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        await copySDKSource(from, to);
      } else if (entry.isFile()) {
        await Bun.write(to, Bun.file(from));
      } else {
        throw new Error("SDK sources must contain ordinary files and directories");
      }
    })
  );
}
