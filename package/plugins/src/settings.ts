import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { type Static, type TObject, Type } from "typebox";
import { Check } from "typebox/value";

export interface SettingsDefinition<Schema extends TObject> {
  defaults: Static<Schema>;
  schema: Schema;
}

export interface PluginSettings<Schema extends TObject> {
  get: (threadId?: string) => Static<Schema>;
  reset: (threadId?: string) => Promise<Static<Schema>>;
  update: (values: Partial<Static<Schema>>, threadId?: string) => Promise<Static<Schema>>;
}

/** Host forms accept unknown input and validate it at the schema boundary. */
export interface PluginSettingsController {
  get: (threadId?: string) => object;
  reset: (threadId?: string) => Promise<object>;
  schema: TObject;
  update: (patch: unknown, threadId?: string) => Promise<object>;
}

export function createSettingsController<Schema extends TObject>(
  definition: SettingsDefinition<Schema>,
  settings: PluginSettings<Schema>
): PluginSettingsController {
  const partial = Type.Partial(definition.schema);
  return {
    get: (threadId) => settings.get(threadId),
    reset: (threadId) => settings.reset(threadId),
    schema: definition.schema,
    update(patch, threadId) {
      if (!Check(partial, patch)) {
        return Promise.reject(new Error("Plugin settings do not match their schema"));
      }
      // TypeBox cannot reduce a generic Partial schema's static type.
      return settings.update(patch as Partial<Static<Schema>>, threadId);
    },
  };
}

const documentSchema = Type.Object({
  global: Type.Unknown(),
  threads: Type.Array(Type.Object({ id: Type.String(), values: Type.Unknown() })),
  version: Type.Literal(1),
});

const pluginIdPattern = /^[a-z][a-z0-9-]*$/;

export function validatePluginId(id: string): void {
  if (!pluginIdPattern.test(id)) {
    throw new Error(
      "Plugin IDs must start with a lowercase letter and contain only lowercase letters, digits, and hyphens"
    );
  }
}

export async function createSettingsStore<Schema extends TObject>(options: {
  directory: string;
  pluginId: string;
  definition: SettingsDefinition<Schema>;
}): Promise<PluginSettings<Schema>> {
  validatePluginId(options.pluginId);
  const { schema, defaults } = options.definition;
  if (!Check(schema, defaults)) {
    throw new Error("Plugin settings defaults do not match their schema");
  }
  const partialSchema = Type.Partial(schema);
  const path = join(options.directory, options.pluginId, "settings.json");
  let global = structuredClone(defaults);
  let threads = new Map<string, Partial<Static<Schema>>>();
  const file = Bun.file(path);
  if (await file.exists()) {
    const document: unknown = await file.json();
    if (!(Check(documentSchema, document) && Check(schema, document.global))) {
      throw new Error("Stored plugin settings are invalid");
    }
    ({ global } = document);
    for (const thread of document.threads) {
      if (!Check(partialSchema, thread.values)) {
        throw new Error("Stored thread settings are invalid");
      }
      // TypeBox cannot reduce a generic Partial schema's static type.
      threads.set(thread.id, thread.values as Partial<Static<Schema>>);
    }
  }
  let pending = Promise.resolve();
  const enqueue = (operation: () => Promise<Static<Schema>>) => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const get = (threadId?: string): Static<Schema> =>
    structuredClone({ ...global, ...(threadId ? threads.get(threadId) : undefined) });
  const save = async (
    nextGlobal: Static<Schema>,
    nextThreads: Map<string, Partial<Static<Schema>>>
  ) => {
    await mkdir(join(options.directory, options.pluginId), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(
      temporary,
      JSON.stringify({
        global: nextGlobal,
        threads: [...nextThreads].map(([id, values]) => ({ id, values })),
        version: 1,
      })
    );
    await rename(temporary, path);
    global = nextGlobal;
    threads = nextThreads;
  };
  return {
    get,
    reset(threadId) {
      return enqueue(async () => {
        const nextThreads = new Map(threads);
        if (threadId) {
          nextThreads.delete(threadId);
        }
        await save(threadId ? global : structuredClone(defaults), nextThreads);
        return get(threadId);
      });
    },
    update(values, threadId) {
      return enqueue(async () => {
        if (!Check(partialSchema, values)) {
          throw new Error("Plugin settings do not match their schema");
        }
        const nextThreads = new Map(threads);
        const nextGlobal = threadId ? global : { ...global, ...values };
        if (threadId) {
          nextThreads.set(threadId, { ...threads.get(threadId), ...values });
        }
        const effective = { ...nextGlobal, ...(threadId ? nextThreads.get(threadId) : undefined) };
        if (!Check(schema, effective)) {
          throw new Error("Plugin settings do not match their schema");
        }
        await save(nextGlobal, nextThreads);
        return get(threadId);
      });
    },
  };
}
