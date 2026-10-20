import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SavedServer {
  alias: string;
  deviceId: string;
  name: string;
  origins: string[];
  serverId: string;
  temporary: boolean;
}

/** Independent from the library database and its lease. Contains no credentials. */
export class ServerCatalog {
  readonly path: string;
  value: { version: 1; startLocal: boolean; servers: SavedServer[] } = {
    servers: [],
    startLocal: true,
    version: 1,
  };
  private saving: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.path = join(directory, "servers.json");
  }

  async read() {
    if (await Bun.file(this.path).exists()) {
      const value = await Bun.file(this.path).json();
      if (
        value.version !== 1 ||
        typeof value.startLocal !== "boolean" ||
        !Array.isArray(value.servers)
      ) {
        throw new Error("The saved server catalog is invalid");
      }
      this.value = value;
    }
    // Connections chosen as memory-only cannot survive this native process.
    this.value.servers = this.value.servers.filter((server) => !server.temporary);
  }

  async save() {
    const previous = this.saving;
    const reservation = Promise.withResolvers<void>();
    this.saving = reservation.promise;
    const serialized = JSON.stringify(this.value);
    try {
      await previous;
      await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
      const temporary = `${this.path}.${crypto.randomUUID()}`;
      await Bun.write(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      reservation.resolve();
    }
  }
}
