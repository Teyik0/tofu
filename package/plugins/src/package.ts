import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { validatePluginId } from "./settings";
import { PLUGIN_API_VERSION } from "./version";

const manifestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  tofuPlugin: Type.Object({
    apiVersion: Type.String(),
    client: Type.String({ minLength: 1 }),
    id: Type.String(),
    server: Type.String({ minLength: 1 }),
  }),
  type: Type.Literal("module"),
  version: Type.String({ minLength: 1 }),
});

export interface InspectedPluginPackage {
  apiVersion: string;
  clientPath: string;
  id: string;
  integrity: string;
  name: string;
  serverPath: string;
  version: string;
}

export interface PackageInspectionOptions {
  integrity?: string;
}

/** Inspection reads package files only. Trust and module loading belong to the host. */
export async function inspectPluginPackage(
  directory: string,
  options?: PackageInspectionOptions
): Promise<InspectedPluginPackage> {
  const root = await realpath(directory);
  const manifest: unknown = await Bun.file(join(root, "package.json")).json();
  if (!Check(manifestSchema, manifest)) {
    throw new Error("The package must provide valid tofuPlugin metadata and ESM entry points");
  }
  const metadata = manifest.tofuPlugin;
  validatePluginId(metadata.id);
  if (metadata.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin API ${metadata.apiVersion} is incompatible with ${PLUGIN_API_VERSION}`);
  }
  const entry = async (path: string) => {
    if (isAbsolute(path)) {
      throw new Error("Plugin entry points must be relative paths inside the package");
    }
    const absolute = join(root, path);
    const contained = relative(root, absolute);
    if (contained.startsWith(`..${sep}`) || contained === ".." || isAbsolute(contained)) {
      throw new Error("Plugin entry points must stay inside the package");
    }
    if (contained.split(sep).some((segment) => segment === ".git" || segment === "node_modules")) {
      throw new Error("Plugin entry points must not be excluded from integrity hashing");
    }
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Plugin entry points must be regular package files");
    }
    return absolute;
  };
  const [serverPath, clientPath] = await Promise.all([
    entry(metadata.server),
    entry(metadata.client),
  ]);
  const hasher = new Bun.CryptoHasher("sha256");
  const visit = async (path: string) => {
    const children = (await readdir(path, { withFileTypes: true })).sort((left, right) => {
      if (left.name === right.name) {
        return 0;
      }
      return left.name < right.name ? -1 : 1;
    });
    for (const child of children) {
      if (child.name === "node_modules" || child.name === ".git") {
        continue;
      }
      const childPath = join(path, child.name);
      if (child.isSymbolicLink()) {
        throw new Error("Plugin package files must not contain symbolic links");
      }
      if (child.isDirectory()) {
        // biome-ignore lint/performance/noAwaitInLoops: Hash files sequentially in a deterministic order.
        await visit(childPath);
      } else if (child.isFile()) {
        const data = await Bun.file(childPath).arrayBuffer();
        hasher.update(
          `${JSON.stringify([relative(root, childPath).split(sep).join("/"), data.byteLength])}\n`
        );
        hasher.update(data);
      } else {
        throw new Error("Plugin packages may contain only regular files and directories");
      }
    }
  };
  await visit(root);
  const integrity = `sha256-${hasher.digest("base64")}`;
  if (options?.integrity && options.integrity !== integrity) {
    throw new Error("Plugin package integrity does not match the installed pin");
  }
  return {
    apiVersion: metadata.apiVersion,
    clientPath,
    id: metadata.id,
    integrity,
    name: manifest.name,
    serverPath,
    version: manifest.version,
  };
}
