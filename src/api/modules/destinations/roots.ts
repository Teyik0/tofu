import { TorrentClient } from "../torrents/layer";
import "@teyik0/furin/server-only";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";
import { problem } from "elysia";
import { storageRoots } from "../../../db/schema";
import { Database } from "../../lib/db";

const PATH_SEGMENTS = /[\\/]+/;
const WINDOWS_DRIVE = /^[a-z]:/i;

interface StorageRootsOptions {
  db: Database["Service"];
  /** Current download folder, offered as the first root when none exists. */
  defaultPath: () => string;
  now: () => number;
}

function within(path: string, root: string) {
  const offset = relative(root, path);
  return offset === "" || !(isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`));
}

/** Real path of `path`, resolving the nearest existing ancestor so new folders can be checked. */
async function canonical(path: string): Promise<string> {
  const result = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ catch: (error) => error, try: () => realpath(path) }))
  );
  if (Result.isFailure(result)) {
    const error = result.failure;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw error;
    }
    return join(await canonical(parent), basename(path));
  }
  return result.success;
}

/**
 * Host folders beneath which remote administrators may place downloads. Only the owner edits
 * the list; every remote path is canonicalized so `..` and symbolic links cannot escape it.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const torrents = yield* TorrentClient;
  const options: StorageRootsOptions = {
    db,
    defaultPath: () => torrents.settings().downloadPath,
    now: Date.now,
  };

  const serviceOptions = options;

  function serviceList() {
    const roots = serviceOptions.db.select().from(storageRoots).all();
    if (roots.length > 0) {
      return roots;
    }
    const path = resolve(serviceOptions.defaultPath());
    const root = {
      createdAt: serviceOptions.now(),
      id: crypto.randomUUID(),
      name: "Downloads",
      path,
    };
    serviceOptions.db.insert(storageRoots).values(root).onConflictDoNothing().run();
    return serviceOptions.db.select().from(storageRoots).all();
  }
  const serviceAdd = Effect.fn("Roots.add")(function* (name: string, path: string) {
    if (!isAbsolute(path)) {
      return problem(400, { detail: "Enter an absolute folder path" });
    }
    const label = name.trim();
    if (!label) {
      return problem(400, { detail: "Enter a name for this storage location" });
    }
    yield* Effect.promise(() => mkdir(path, { recursive: true }));
    const real = yield* Effect.promise(() => realpath(path));
    if (serviceList().some((existing) => existing.path === real)) {
      return problem(409, { detail: "This folder is already a storage location" });
    }
    const root = {
      createdAt: serviceOptions.now(),
      id: crypto.randomUUID(),
      name: label,
      path: real,
    };
    serviceOptions.db.insert(storageRoots).values(root).run();
    return root;
  });
  function serviceRemove(id: string) {
    const roots = serviceList();
    if (!roots.some((root) => root.id === id)) {
      return problem(404, { detail: "Storage location not found" });
    }
    if (roots.length === 1) {
      return problem(409, { detail: "Keep at least one storage location" });
    }
    serviceOptions.db.delete(storageRoots).where(eq(storageRoots.id, id)).run();
    return { removed: id };
  }
  const serviceResolveFolder = Effect.fn("Roots.resolveFolder")(function* (
    rootId: string,
    folder: string
  ) {
    const root = serviceList().find((candidate) => candidate.id === rootId);
    if (!root) {
      return problem(404, { detail: "Storage location not found" });
    }
    const segments = folder.split(PATH_SEGMENTS).filter(Boolean);
    if (
      isAbsolute(folder) ||
      WINDOWS_DRIVE.test(folder) ||
      folder.startsWith("\\") ||
      segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))
    ) {
      return problem(400, { detail: "Enter a folder name inside the storage location" });
    }
    const path = join(root.path, ...segments);
    const canonicalRoot = yield* Effect.promise(() => canonical(root.path));
    if (
      !(
        within(yield* Effect.promise(() => canonical(path)), canonicalRoot) &&
        (yield* serviceContains(path))
      )
    ) {
      return problem(403, { detail: "This folder is outside the server's storage locations" });
    }
    return path;
  });
  const serviceContains = Effect.fn("Roots.contains")(function* (path: string) {
    if (!isAbsolute(path)) {
      return false;
    }
    const real = yield* Effect.promise(() => canonical(resolve(path)));
    const roots = yield* Effect.promise(() =>
      Promise.all(serviceList().map((root) => canonical(root.path)))
    );
    if (!roots.some((root) => within(real, root))) {
      return false;
    }
    // A dangling symbolic link at the target would be followed when the folder is created.
    const info = yield* Effect.result(
      Effect.tryPromise({ catch: (error) => error, try: () => lstat(resolve(path)) })
    );
    if (Result.isFailure(info)) {
      return (
        info.failure instanceof Error && "code" in info.failure && info.failure.code === "ENOENT"
      );
    }
    return !info.success.isSymbolicLink();
  });

  return {
    add: serviceAdd,
    contains: serviceContains,
    list: serviceList,
    remove: serviceRemove,
    resolveFolder: serviceResolveFolder,
  };
});

export type StorageRoots = Roots["Service"];
export class Roots extends Context.Service<
  Roots,
  {
    readonly list: () => { createdAt: number; id: string; name: string; path: string }[];
    readonly add: (
      name: string,
      path: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<400, { readonly detail: "Enter an absolute folder path" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a name for this storage location" }>
        >
      | ReturnType<
          typeof problem<409, { readonly detail: "This folder is already a storage location" }>
        >
      | {
          createdAt: number;
          id: `${string}-${string}-${string}-${string}-${string}`;
          name: string;
          path: string;
        }
    >;
    readonly remove: (
      id: string
    ) =>
      | ReturnType<typeof problem<404, { readonly detail: "Storage location not found" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Keep at least one storage location" }>>
      | { removed: string };
    readonly resolveFolder: (
      rootId: string,
      folder: string
    ) => Effect.Effect<
      | string
      | ReturnType<typeof problem<404, { readonly detail: "Storage location not found" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Enter a folder name inside the storage location" }
          >
        >
      | ReturnType<
          typeof problem<
            403,
            { readonly detail: "This folder is outside the server's storage locations" }
          >
        >
    >;
    readonly contains: (path: string) => Effect.Effect<boolean>;
  }
>()("tofu/storage-roots") {}
export const rootsLayer = Layer.effect(Roots, make);
