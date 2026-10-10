import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { PluginCredentials } from "./auth";
import { validatePluginId } from "./settings";

const credentialSchema = Type.Object({
  entries: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
  version: Type.Literal(1),
});

/** Private host-owned storage; file permissions provide local OS isolation, not encryption. */
export async function createCredentialStore(options: {
  directory: string;
  pluginId: string;
}): Promise<PluginCredentials> {
  validatePluginId(options.pluginId);
  const directory = join(options.directory, options.pluginId);
  const path = join(directory, "credentials.json");
  let entries = new Map<string, string>();
  if (await Bun.file(path).exists()) {
    const document: unknown = await Bun.file(path).json();
    if (!Check(credentialSchema, document)) {
      throw new Error("Stored plugin credentials are invalid");
    }
    entries = new Map(document.entries.map(({ name, value }) => [name, value]));
    await chmod(path, 0o600);
  }
  let pending = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const save = async (next: Map<string, string>) => {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(
          JSON.stringify({
            entries: [...next].map(([name, value]) => ({ name, value })),
            version: 1,
          })
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      entries = next;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  return {
    delete(name) {
      return enqueue(async () => {
        const next = new Map(entries);
        next.delete(name);
        await save(next);
      });
    },
    async get(name) {
      await pending;
      return entries.get(name) ?? null;
    },
    set(name, value) {
      return enqueue(async () => {
        const next = new Map(entries);
        next.set(name, value);
        await save(next);
      });
    },
  };
}
