import "@teyik0/furin/server-only";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { problem } from "elysia";
import { storageRoots } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";

const PATH_SEGMENTS = /[\\/]+/;
const WINDOWS_DRIVE = /^[a-z]:/i;

interface StorageRootsOptions {
  db: TofuDatabase;
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
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw error;
    }
    return join(await canonical(parent), basename(path));
  }
}

/**
 * Host folders beneath which remote administrators may place downloads. Only the owner edits
 * the list; every remote path is canonicalized so `..` and symbolic links cannot escape it.
 */
export class StorageRoots {
  private readonly options: StorageRootsOptions;

  constructor(options: StorageRootsOptions) {
    this.options = options;
  }

  list() {
    const roots = this.options.db.select().from(storageRoots).all();
    if (roots.length > 0) {
      return roots;
    }
    const path = resolve(this.options.defaultPath());
    const root = {
      createdAt: this.options.now(),
      id: crypto.randomUUID(),
      name: "Downloads",
      path,
    };
    this.options.db.insert(storageRoots).values(root).onConflictDoNothing().run();
    return this.options.db.select().from(storageRoots).all();
  }

  async add(name: string, path: string) {
    if (!isAbsolute(path)) {
      return problem(400, { detail: "Enter an absolute folder path" });
    }
    const label = name.trim();
    if (!label) {
      return problem(400, { detail: "Enter a name for this storage location" });
    }
    await mkdir(path, { recursive: true });
    const real = await realpath(path);
    if (this.list().some((existing) => existing.path === real)) {
      return problem(409, { detail: "This folder is already a storage location" });
    }
    const root = {
      createdAt: this.options.now(),
      id: crypto.randomUUID(),
      name: label,
      path: real,
    };
    this.options.db.insert(storageRoots).values(root).run();
    return root;
  }

  remove(id: string) {
    const roots = this.list();
    if (!roots.some((root) => root.id === id)) {
      return problem(404, { detail: "Storage location not found" });
    }
    if (roots.length === 1) {
      return problem(409, { detail: "Keep at least one storage location" });
    }
    this.options.db.delete(storageRoots).where(eq(storageRoots.id, id)).run();
    return { removed: id };
  }

  /**
   * Resolves `folder` beneath root `rootId`. Rejects absolute or parent segments, and paths whose
   * existing ancestors resolve outside the root through symbolic links.
   */
  async resolveFolder(rootId: string, folder: string) {
    const root = this.list().find((candidate) => candidate.id === rootId);
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
    const canonicalRoot = await canonical(root.path);
    if (!(within(await canonical(path), canonicalRoot) && (await this.contains(path)))) {
      return problem(403, { detail: "This folder is outside the server's storage locations" });
    }
    return path;
  }

  /** Whether `path` canonically lies inside a storage root, following symbolic links. */
  async contains(path: string) {
    if (!isAbsolute(path)) {
      return false;
    }
    const real = await canonical(resolve(path));
    const roots = await Promise.all(this.list().map((root) => canonical(root.path)));
    if (!roots.some((root) => within(real, root))) {
      return false;
    }
    // A dangling symbolic link at the target would be followed when the folder is created.
    try {
      return !(await lstat(resolve(path))).isSymbolicLink();
    } catch {
      return true;
    }
  }
}
