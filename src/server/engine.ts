import { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import parseTorrent, { toMagnetURI } from "parse-torrent";
import WebTorrent, { type Options, type Torrent } from "webtorrent";
import type {
  DashboardState,
  Destination,
  DestinationInput,
  FilePriority,
  Settings,
  SettingsInput,
  SpeedSample,
  TorrentDetail,
  TrackerStats,
} from "../types";
import { announce, peers, watchTrackers } from "./webtorrent-stats";

export class UserError extends Error {
  readonly status: number;
  constructor(message: string, options: ErrorOptions & { status: number }) {
    super(message, options);
    this.status = options.status;
  }
}

interface RelocatedFile {
  source: string;
  staged: string;
  target: string;
}

function storedFile(path: string) {
  return lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  });
}

function moveError(cause: unknown) {
  if (cause instanceof UserError) {
    return cause;
  }
  const code = cause instanceof Error && "code" in cause ? cause.code : null;
  let message = "Impossible de déplacer les fichiers";
  if (code === "ENOSPC") {
    message = "Espace insuffisant dans le dossier de destination";
  }
  if (code === "EACCES" || code === "EPERM") {
    message = "Permission refusée lors du déplacement des fichiers";
  }
  if (code === "EEXIST") {
    message = "Un fichier existe déjà dans le dossier de destination";
  }
  return new UserError(`${message}. Les fichiers d’origine sont conservés.`, {
    cause,
    status: 409,
  });
}

interface Entry {
  detail: TorrentDetail;
  metadata: string | null;
  moving?: boolean;
  operation: Promise<void>;
  paused: boolean;
  source: string;
  storageClaimed: boolean;
  torrent: Torrent | null;
  unwatch?: () => void;
  verifying?: boolean;
}
function entryStatus(entry: Entry): TorrentDetail["status"] {
  if (entry.moving) {
    return "moving";
  }
  if (entry.verifying) {
    return "checking";
  }
  if (entry.paused) {
    return "paused";
  }
  if (entry.detail.error) {
    return "error";
  }
  if (!entry.torrent?.ready) {
    return entry.torrent?.metadata ? "checking" : "metadata";
  }
  if (entry.torrent.done) {
    return "seeding";
  }
  return entry.torrent.downloadSpeed > 0 ? "downloading" : "idle";
}

type StoredEntry = Pick<Entry, "source" | "metadata" | "paused" | "detail"> & {
  storageClaimed?: boolean;
};

const torrentUrl = /^https?:\/\//;
const trackerProtocols = new Set(["http:", "https:", "udp:", "ws:", "wss:"]);
export function trackerUrls(urls: string[]) {
  return [...new Set(urls.map((value) => value.trim()).filter(Boolean))].map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new UserError(`Tracker invalide : ${value}`, { cause, status: 400 });
    }
    if (!trackerProtocols.has(url.protocol)) {
      throw new UserError("Les trackers doivent utiliser HTTP, HTTPS, UDP ou WebSocket", {
        status: 400,
      });
    }
    return value;
  });
}

function trackerStats(url: string): TrackerStats {
  return {
    interval: null,
    lastAnnounce: null,
    leeches: null,
    message: null,
    seeds: null,
    status: "waiting",
    url,
  };
}

export class TorrentEngine {
  readonly client: WebTorrent;
  readonly settings: Settings;
  private readonly entries = new Map<string, Entry>();
  private readonly destinations = new Map<string, Destination>();
  private readonly movingDestinations = new Set<string>();
  private destinationOperation: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private readonly db: Database;
  private readonly history: SpeedSample[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private received = 0;
  private uploaded = 0;
  private freeSpace: number | null = null;
  private lastTick = Date.now();
  private lastDiskAt = 0;
  private lastPersistAt = 0;
  mode: "desktop" | "server" = "server";

  private constructor(settings: Settings, network: Options, dataDir: string) {
    this.db = new Database(join(dataDir, "tofu.sqlite"), { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS torrents (id TEXT PRIMARY KEY, value TEXT NOT NULL);"
    );
    const stored = this.db
      .query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
      .get("settings");
    this.settings = stored ? { ...settings, ...(JSON.parse(stored.value) as Settings) } : settings;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS destinations (id TEXT PRIMARY KEY, name TEXT NOT NULL, downloadPath TEXT NOT NULL)"
    );
    for (const destination of this.db
      .query<Destination, []>("SELECT * FROM destinations ORDER BY rowid")
      .all()) {
      this.destinations.set(destination.id, destination);
    }
    if (!this.destinations.has("default")) {
      this.storeDestination({
        downloadPath: this.settings.downloadPath,
        id: "default",
        name: "Téléchargements",
      });
    }
    const totals = this.db
      .query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
      .get("traffic");
    if (totals) {
      const parsed: { received: number; uploaded: number } = JSON.parse(totals.value);
      this.received = parsed.received;
      this.uploaded = parsed.uploaded;
    }
    this.client = new WebTorrent(network);
    this.client.throttleDownload(this.settings.downloadLimit);
    this.client.throttleUpload(this.settings.uploadLimit);
    this.client.on("error", console.error);
    for (const row of this.db
      .query<{ value: string }, []>("SELECT value FROM torrents ORDER BY rowid")
      .all()) {
      const storedEntry: StoredEntry = JSON.parse(row.value);
      storedEntry.detail.destinationId ??= this.destinationForPath(
        dirname(storedEntry.detail.savePath)
      ).id;
      this.entries.set(storedEntry.detail.id, {
        ...storedEntry,
        operation: Promise.resolve(),
        storageClaimed: storedEntry.storageClaimed ?? storedEntry.detail.error === null,
        torrent: null,
      });
    }
    this.timer = setInterval(() => {
      const now = Date.now();
      const seconds = (now - this.lastTick) / 1000;
      this.lastTick = now;
      for (const entry of this.entries.values()) {
        if (!entry.paused && entry.torrent) {
          entry.detail.activeSeconds += seconds;
          if (entry.torrent.done) {
            entry.detail.seedSeconds += seconds;
          }
        }
        this.summary(entry);
      }
      if (now - this.lastPersistAt >= 5000) {
        this.db.transaction(() => {
          for (const entry of this.entries.values()) {
            this.save(entry);
          }
          this.config("traffic", { received: this.received, uploaded: this.uploaded });
        })();
        this.lastPersistAt = now;
      }
      this.history.push({
        download: this.client.downloadSpeed,
        time: now,
        upload: this.client.uploadSpeed,
      });
      if (this.history.length > 120) {
        this.history.shift();
      }
      if (now - this.lastDiskAt >= 15_000) {
        this.diskSpace();
      }
    }, 1000);
    this.timer.unref();
  }

  static async open(options: { dataDir: string; downloadPath: string; network: Options }) {
    await mkdir(options.dataDir, { recursive: true });
    await mkdir(options.downloadPath, { recursive: true });
    const engine = new TorrentEngine(
      {
        downloadLimit: -1,
        downloadPath: options.downloadPath,
        runInBackground: false,
        uploadLimit: -1,
      },
      options.network,
      options.dataDir
    );
    await mkdir(engine.settings.downloadPath, { recursive: true });
    await engine.diskSpace();
    await Promise.all(
      [...engine.entries.values()]
        .filter((entry) => !entry.paused)
        .map((entry) => engine.start(entry))
    );
    return engine;
  }

  private async diskSpace() {
    this.lastDiskAt = Date.now();
    try {
      const disk = await statfs(this.settings.downloadPath);
      this.freeSpace = disk.bavail * disk.bsize;
    } catch {
      this.freeSpace = null;
    }
  }

  private config(key: string, value: Settings | { received: number; uploaded: number }) {
    this.db
      .query("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  }

  private save(entry: Entry) {
    const { source, metadata, paused, detail, storageClaimed } = entry;
    this.db
      .query("INSERT OR REPLACE INTO torrents (id, value) VALUES (?, ?)")
      .run(
        detail.id,
        JSON.stringify({ detail, metadata, paused, source, storageClaimed } satisfies StoredEntry)
      );
  }

  private storeDestination(destination: Destination) {
    this.db
      .query(
        "INSERT INTO destinations (id, name, downloadPath) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, downloadPath=excluded.downloadPath"
      )
      .run(destination.id, destination.name, destination.downloadPath);
    this.destinations.set(destination.id, destination);
    return destination;
  }

  private destinationForPath(downloadPath: string) {
    return (
      [...this.destinations.values()].find(
        (destination) => destination.downloadPath === downloadPath
      ) ??
      this.storeDestination({
        downloadPath,
        id: crypto.randomUUID(),
        name: basename(downloadPath) || "Téléchargements",
      })
    );
  }

  async saveDestination(id: string | null, input: DestinationInput) {
    const name = input.name.trim();
    if (!(name && isAbsolute(input.downloadPath))) {
      throw new UserError("Indiquez un nom et un chemin de dossier absolu", { status: 400 });
    }
    if (id && !this.destinations.has(id)) {
      throw new UserError("Onglet introuvable", { status: 404 });
    }
    if (this.movingDestinations.size > 0) {
      throw new UserError("Un déplacement est déjà en cours pour cet onglet", { status: 409 });
    }
    const downloadPath = resolvePath(input.downloadPath);
    if (id && input.moveFiles) {
      const operation = this.moveDestination(id, downloadPath, name);
      this.destinationOperation = operation;
      try {
        await operation;
      } finally {
        this.destinationOperation = null;
      }
      return { downloadPath, id, name };
    }
    await mkdir(input.downloadPath, { recursive: true });
    if (this.movingDestinations.size > 0) {
      throw new UserError("Un déplacement est déjà en cours pour cet onglet", { status: 409 });
    }
    const destination = this.storeDestination({
      downloadPath,
      id: id ?? crypto.randomUUID(),
      name,
    });
    if (destination.id === "default") {
      this.settings.downloadPath = destination.downloadPath;
      this.config("settings", this.settings);
      await this.diskSpace();
    }
    return destination;
  }

  private async moveDestination(id: string, downloadPath: string, name: string) {
    const entries = [...this.entries.values()].filter(
      (entry) =>
        entry.detail.destinationId === id && resolvePath(entry.detail.savePath) !== downloadPath
    );
    this.validateMove(entries);
    this.movingDestinations.add(id);
    for (const entry of entries) {
      entry.moving = true;
    }
    let running: Entry[] = [];
    let files: RelocatedFile[] = [];
    const originalPaths = new Map(entries.map((entry) => [entry, entry.detail.savePath]));
    const originalDestination = this.destinations.get(id);
    const originalDefaultPath = this.settings.downloadPath;
    const published: string[] = [];
    let staging: string | null = null;
    let committed = false;
    try {
      await Promise.all(entries.map((entry) => entry.operation.catch(() => undefined)));
      running = entries.filter(
        (entry) => !entry.paused && this.entries.get(entry.detail.id) === entry
      );
      this.validateMove(entries);
      await Promise.all(entries.map((entry) => this.stop(entry)));
      await mkdir(downloadPath, { recursive: true });
      staging = await mkdtemp(join(downloadPath, ".tofu-move-"));
      files = await this.planMove(entries, downloadPath, staging);
      const copies = await Promise.allSettled(
        files.map((file) => copyFile(file.source, file.staged))
      );
      const failure = copies.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
      await this.publishMove(files, published);
      this.db.transaction(() => {
        for (const entry of entries) {
          entry.detail.savePath = downloadPath;
          this.save(entry);
        }
        this.storeDestination({ downloadPath, id, name });
        if (id === "default") {
          this.settings.downloadPath = downloadPath;
          this.config("settings", this.settings);
        }
      })();
      committed = true;
      const cleanup = await Promise.allSettled(files.map((file) => rm(file.source)));
      if (cleanup.some((result) => result.status === "rejected")) {
        throw new UserError(
          "Les fichiers ont été déplacés, mais certaines copies dans l’ancien dossier n’ont pas pu être retirées. Le nouveau dossier est actif.",
          { status: 500 }
        );
      }
    } catch (cause) {
      if (!committed) {
        for (const [entry, path] of originalPaths) {
          entry.detail.savePath = path;
        }
        if (originalDestination) {
          this.destinations.set(id, originalDestination);
        }
        this.settings.downloadPath = originalDefaultPath;
        await Promise.all(published.map((path) => rm(path, { force: true })));
      }
      throw moveError(cause);
    } finally {
      try {
        if (staging) {
          await rm(staging, { force: true, recursive: true });
        }
      } finally {
        for (const entry of entries) {
          entry.moving = false;
        }
        try {
          await Promise.all(
            running.filter((entry) => !entry.torrent).map((entry) => this.start(entry))
          );
        } finally {
          this.movingDestinations.delete(id);
        }
        await this.diskSpace();
      }
    }
  }

  private validateMove(entries: Entry[]) {
    for (const entry of entries) {
      if (this.entries.get(entry.detail.id) !== entry) {
        throw new UserError("Torrent introuvable", { status: 404 });
      }
      const status = entryStatus(entry);
      if (
        status === "checking" ||
        entry.verifying ||
        (entry.torrent?.metadata && !entry.torrent.ready)
      ) {
        throw new UserError(
          `${entry.detail.name} est en cours de vérification. Réessayez une fois la vérification terminée.`,
          { status: 409 }
        );
      }
      if (!entry.metadata || status === "metadata") {
        throw new UserError(
          `Les métadonnées de ${entry.detail.name} ne sont pas encore disponibles.`,
          { status: 409 }
        );
      }
      if (entry.detail.error) {
        throw new UserError(`Impossible de déplacer ${entry.detail.name} : ${entry.detail.error}`, {
          status: 409,
        });
      }
    }
  }

  private async planMove(entries: Entry[], downloadPath: string, staging: string) {
    const reserved = new Set(
      [...this.entries.values()]
        .filter((entry) => !entries.includes(entry) && entry.storageClaimed)
        .flatMap((entry) =>
          entry.detail.files.map((file) => this.storageKey(entry.detail.savePath, file.path))
        )
    );
    const planned = entries.flatMap((entry) =>
      entry.detail.files.map((file) => ({
        file,
        source: this.storagePath(entry.detail.savePath, file.path),
        sourceKey: this.storageKey(entry.detail.savePath, file.path),
        target: this.storagePath(downloadPath, file.path),
        targetKey: this.storageKey(downloadPath, file.path),
      }))
    );
    const sources = new Set(planned.map((item) => item.sourceKey));
    const targets = new Set<string>();
    for (const item of planned) {
      if (
        reserved.has(item.sourceKey) ||
        reserved.has(item.targetKey) ||
        targets.has(item.targetKey) ||
        sources.has(item.targetKey)
      ) {
        throw new UserError(
          `Le fichier ${item.file.path} est déjà utilisé par un autre torrent. Choisissez un autre dossier.`,
          { status: 409 }
        );
      }
      targets.add(item.targetKey);
    }
    const files = await Promise.all(
      planned.map(async ({ file, source, target }, index) => {
        const [existing, stored] = await Promise.all([storedFile(target), storedFile(source)]);
        if (existing) {
          throw new UserError(
            `Un fichier existe déjà dans le dossier de destination : ${target}. Il ne sera pas écrasé.`,
            { status: 409 }
          );
        }
        if (!stored) {
          if (file.downloaded > 0 || (file.progress === 1 && file.length > 0)) {
            throw new UserError(
              `Le fichier téléchargé n’est plus présent : ${source}. Restaurez-le ou vérifiez le torrent avant de réessayer.`,
              { status: 404 }
            );
          }
          return null;
        }
        if (!stored.isFile()) {
          throw new UserError(`Ce chemin n’est pas un fichier : ${source}`, { status: 409 });
        }
        if (stored.size < file.downloaded) {
          throw new UserError(
            `Le fichier téléchargé a été modifié ou tronqué : ${source}. Vérifiez le torrent avant de le déplacer.`,
            { status: 409 }
          );
        }
        return { source, staged: join(staging, String(index)), target };
      })
    );
    return files.filter((file) => file !== null);
  }

  private async publishMove(files: RelocatedFile[], published: string[]) {
    const results = await Promise.allSettled(
      files.map(async (file) => {
        await mkdir(dirname(file.target), { recursive: true });
        // Publish the staged copy on the same volume without overwriting any file.
        await link(file.staged, file.target);
        published.push(file.target);
      })
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  private storageKey(savePath: string, filePath: string) {
    try {
      return resolvePath(realpathSync(savePath), filePath);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
        return resolvePath(savePath, filePath);
      }
      throw cause;
    }
  }

  private storagePath(savePath: string, filePath: string) {
    const path = resolvePath(savePath, filePath);
    const within = relative(savePath, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new UserError("Chemin de fichier hors du dossier de téléchargement", { status: 400 });
    }
    let component = savePath;
    for (const part of within.split(sep)) {
      component = join(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) {
          throw new UserError("Un lien symbolique est présent dans le chemin du fichier", {
            status: 409,
          });
        }
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          break;
        }
        throw cause;
      }
    }
    return path;
  }

  private resolveDestination(options: { destinationId?: string; downloadPath?: string }) {
    const chosen = this.destinations.get(options.destinationId ?? "");
    if (options.destinationId && !chosen) {
      throw new UserError("Onglet introuvable", { status: 404 });
    }
    const downloadPath =
      chosen?.downloadPath ?? (options.downloadPath || this.settings.downloadPath);
    if (!isAbsolute(downloadPath)) {
      throw new UserError("Le dossier de téléchargement doit être un chemin absolu", {
        status: 400,
      });
    }
    const destination = chosen ?? this.destinationForPath(downloadPath);
    if (this.movingDestinations.size > 0) {
      throw new UserError("Attendez la fin du déplacement avant d’ajouter un torrent", {
        status: 409,
      });
    }
    return destination;
  }

  async add(
    input: string | Uint8Array,
    options: { paused: boolean; destinationId?: string; downloadPath?: string; trackers?: string[] }
  ) {
    let source = input;
    if (typeof source === "string" && torrentUrl.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new UserError(`Le fichier torrent est inaccessible (HTTP ${response.status})`, {
          status: 400,
        });
      }
      source = new Uint8Array(await response.arrayBuffer());
      if (source.length > 8 * 1024 * 1024) {
        throw new UserError("Le fichier torrent est trop volumineux", { status: 400 });
      }
    }
    let parsed: Awaited<ReturnType<typeof parseTorrent>>;
    try {
      parsed = await parseTorrent(source);
    } catch (cause) {
      throw new UserError("Lien magnet ou fichier .torrent invalide (BitTorrent v1 requis)", {
        cause,
        status: 400,
      });
    }
    const id = parsed.infoHash;
    parsed.announce = trackerUrls([...parsed.announce, ...(options.trackers ?? [])]);
    const destination = this.resolveDestination(options);
    const { downloadPath } = destination;
    const savePath = downloadPath;
    await mkdir(savePath, { recursive: true });
    if (this.movingDestinations.size > 0) {
      throw new UserError("Attendez la fin du déplacement avant d’ajouter un torrent", {
        status: 409,
      });
    }
    if (this.entries.has(id)) {
      throw new UserError("Ce torrent est déjà dans votre bibliothèque", { status: 409 });
    }

    const detail: TorrentDetail = {
      activeSeconds: 0,
      addedAt: Date.now(),
      comment: "",
      completedAt: null,
      createdBy: "",
      destinationId: destination.id,
      downloaded: 0,
      downloadSpeed: 0,
      error: null,
      eta: null,
      files: (parsed.files ?? []).map((file, index) => ({
        downloaded: 0,
        index,
        length: file.length,
        name: file.name,
        path: file.path,
        priority: "normal",
        progress: 0,
      })),
      id,
      lastTransferAt: null,
      length: parsed.length ?? 0,
      magnet: toMagnetURI(parsed),
      name: parsed.name || id,
      peerList: [],
      peers: 0,
      pieceLength: 0,
      pieceMap: [],
      pieces: 0,
      private: parsed.private ?? false,
      progress: 0,
      ratio: null,
      received: 0,
      savePath,
      seedSeconds: 0,
      seeds: 0,
      status: "metadata",
      swarmPeers: null,
      swarmSeeds: null,
      trackers: parsed.announce.map(trackerStats),
      uploaded: 0,
      uploadSpeed: 0,
      verifiedPieces: 0,
    };
    const entry: Entry = {
      detail,
      metadata: parsed.info ? Buffer.from(source as Uint8Array).toString("base64") : null,
      operation: Promise.resolve(),
      paused: options.paused,
      source: detail.magnet,
      storageClaimed: false,
      torrent: null,
    };
    this.entries.set(id, entry);
    if (!options.paused) {
      await this.start(entry);
    }
    this.save(entry);
    return { id };
  }

  private storageCollision(entry: Entry, torrent: Torrent) {
    const reserved = new Set(
      [...this.entries.values()]
        .filter((other) => other !== entry && other.storageClaimed)
        .flatMap((other) =>
          other.detail.files.map((file) => this.storageKey(other.detail.savePath, file.path))
        )
    );
    return torrent.files.find((file) =>
      reserved.has(this.storageKey(entry.detail.savePath, file.path))
    );
  }

  private async start(entry: Entry) {
    const parsed = await parseTorrent(
      entry.metadata ? Buffer.from(entry.metadata, "base64") : entry.source
    );
    parsed.peerAddresses = (await parseTorrent(entry.source)).peerAddresses;
    parsed.announce = entry.detail.trackers.map((tracker) => tracker.url);
    entry.detail.error = null;
    entry.torrent = this.client.add(parsed, {
      deselect: true,
      path: entry.detail.savePath,
      paused: entry.paused,
    });
    const { torrent } = entry;
    const { detail } = entry;
    torrent.on("metadata", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      let collision: Torrent["files"][number] | undefined;
      try {
        // This callback runs before WebTorrent verifies or writes its filesystem store.
        for (const file of torrent.files) {
          this.storagePath(detail.savePath, file.path);
        }
        collision = this.storageCollision(entry, torrent);
      } catch (cause) {
        detail.error = cause instanceof Error ? cause.message : "Chemin de fichier invalide";
        entry.torrent = null;
        entry.unwatch?.();
        torrent.destroy({ destroyStore: false });
        this.save(entry);
        return;
      }
      // Reserve the metadata paths before another torrent becomes ready.
      const savedFiles = new Map(detail.files.map((file) => [file.path, file]));
      detail.files = torrent.files.map((file, index) => ({
        downloaded: savedFiles.get(file.path)?.downloaded ?? 0,
        index,
        length: file.length,
        name: file.name,
        path: file.path,
        priority: savedFiles.get(file.path)?.priority ?? "normal",
        progress: savedFiles.get(file.path)?.progress ?? 0,
      }));
      entry.storageClaimed = !collision;
      if (collision) {
        detail.error = `Le fichier ${collision.path} est déjà utilisé par un autre torrent. Choisissez un autre dossier.`;
        entry.torrent = null;
        entry.unwatch?.();
        torrent.destroy({ destroyStore: false });
      }
      this.save(entry);
    });
    // WebTorrent 3.0.21 compares against torrent.peerId rather than client.peerId.
    torrent.on("wire", (wire: Torrent["wires"][number], address: string | undefined) => {
      if (wire.peerId !== this.client.peerId) {
        return;
      }
      if (address) {
        torrent.removePeer(address);
      }
      wire.destroy();
    });
    torrent.on("download", (bytes) => {
      detail.received += bytes;
      this.received += bytes;
      detail.lastTransferAt = Date.now();
    });
    torrent.on("upload", (bytes) => {
      detail.uploaded += bytes;
      this.uploaded += bytes;
      detail.lastTransferAt = Date.now();
    });
    torrent.on("error", (error) => {
      detail.error = String(error);
      if (entry.torrent === torrent) {
        entry.torrent = null;
      }
      entry.unwatch?.();
    });
    torrent.on("ready", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      this.details(entry);
      this.selectFiles(entry);
      this.save(entry);
    });
    torrent.on("done", () => {
      detail.completedAt ??= Date.now();
      this.details(entry);
      this.save(entry);
    });
    entry.unwatch = watchTrackers(torrent, detail.trackers);
  }

  private async stop(entry: Entry) {
    const { torrent } = entry;
    if (!torrent) {
      return;
    }
    this.details(entry);
    entry.unwatch?.();
    entry.torrent = null;
    if (await this.client.get(entry.detail.id)) {
      await new Promise<void>((resolve, reject) =>
        this.client.remove(torrent.infoHash, { destroyStore: false }, (error) =>
          error ? reject(error) : resolve()
        )
      );
    }
  }

  private serial(entry: Entry, action: () => Promise<void>) {
    if (entry.moving) {
      throw new UserError(
        "Les fichiers de ce torrent sont en cours de déplacement. Réessayez ensuite.",
        { status: 409 }
      );
    }
    const next = entry.operation
      .catch(() => undefined)
      .then(async () => {
        if (this.entries.get(entry.detail.id) !== entry) {
          throw new UserError("Torrent introuvable", { status: 404 });
        }
        await action();
        if (this.entries.get(entry.detail.id) === entry) {
          this.save(entry);
        }
      });
    entry.operation = next;
    return next;
  }

  async pause(id: string) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      entry.paused = true;
      await this.stop(entry);
    });
    return { ok: true };
  }

  async resume(id: string) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      entry.paused = false;
      if (!entry.torrent) {
        await this.start(entry);
      }
    });
    return { ok: true };
  }

  async replaceTrackers(id: string, urls: string[]) {
    const valid = trackerUrls(urls);
    const entry = this.get(id);
    await this.serial(entry, async () => {
      await this.stop(entry);
      entry.detail.trackers = valid.map(trackerStats);
      const parsed = await parseTorrent(entry.source);
      parsed.announce = valid;
      entry.source = toMagnetURI(parsed);
      entry.detail.magnet = entry.source;
      if (!entry.paused) {
        await this.start(entry);
      }
    });
    return { ok: true };
  }

  async remove(id: string, deleteFiles: boolean) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      await this.stop(entry);
      if (deleteFiles && entry.storageClaimed) {
        const shared = new Set(
          [...this.entries.values()]
            .filter((other) => other !== entry && other.storageClaimed)
            .flatMap((other) =>
              other.detail.files.map((file) => this.storageKey(other.detail.savePath, file.path))
            )
        );
        const paths = entry.detail.files.map((file) => ({
          key: this.storageKey(entry.detail.savePath, file.path),
          path: this.storagePath(entry.detail.savePath, file.path),
        }));
        await Promise.all(
          paths.map(async ({ key, path }) => {
            if (!shared.has(key)) {
              await rm(path, { force: true });
            }
          })
        );
      }
      this.entries.delete(id);
      this.db.query("DELETE FROM torrents WHERE id = ?").run(id);
    });
    return { ok: true };
  }

  private selectFiles(entry: Entry) {
    const { torrent } = entry;
    if (!torrent?.ready) {
      return;
    }
    // A file's last piece may also contain the next file; finish deselection first.
    for (const file of torrent.files) {
      file.deselect();
    }
    for (const file of entry.detail.files) {
      const runtime = torrent.files[file.index];
      if (!runtime) {
        continue;
      }
      if (file.priority !== "skip") {
        runtime.select(file.priority === "high" ? 10 : 0);
      }
    }
  }

  async priority(id: string, index: number, priority: FilePriority) {
    const entry = this.get(id);
    await this.serial(entry, () => {
      const file = this.details(entry).files[index];
      if (!file) {
        throw new UserError("Fichier introuvable", { status: 404 });
      }
      file.priority = priority;
      this.selectFiles(entry);
      return Promise.resolve();
    });
    return { ok: true };
  }

  async verify(id: string) {
    const entry = this.get(id);
    if (entry.verifying || entryStatus(entry) === "checking") {
      throw new UserError("Une vérification est déjà en cours pour ce torrent", { status: 409 });
    }
    if (!entry.metadata) {
      throw new UserError("Les métadonnées doivent être disponibles avant la vérification", {
        status: 409,
      });
    }
    const operation = this.serial(entry, async () => {
      await this.stop(entry);
      await this.start(entry);
      const { torrent } = entry;
      if (!torrent) {
        throw new UserError("Vérification impossible", { status: 500 });
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new UserError("La vérification a dépassé le délai de 60 secondes", { status: 408 })
            ),
          60_000
        );
        torrent.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
        torrent.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      this.details(entry);
      if (entry.paused) {
        await this.stop(entry);
      }
    });
    entry.verifying = true;
    try {
      await operation;
    } finally {
      entry.verifying = false;
    }
    return { ok: true };
  }

  addPeer(id: string, peer: string) {
    const entry = this.get(id);
    if (!entry.torrent || entry.paused) {
      throw new UserError("Reprenez le torrent avant d'ajouter un pair", { status: 409 });
    }
    let address: URL;
    try {
      address = new URL(`tcp://${peer}`);
    } catch (cause) {
      throw new UserError("Adresse invalide, utilisez IP:port", { cause, status: 400 });
    }
    if (!(address.hostname && address.port) || Number(address.port) < 1) {
      throw new UserError("Adresse invalide, utilisez IP:port", { status: 400 });
    }
    if (!entry.torrent.addPeer(peer)) {
      throw new UserError("Ce pair est invalide ou déjà connecté", { status: 400 });
    }
    return parseTorrent(entry.source).then((parsed) => {
      parsed.peerAddresses = [...new Set([...(parsed.peerAddresses ?? []), peer])];
      entry.source = toMagnetURI(parsed);
      entry.detail.magnet = entry.source;
      this.save(entry);
      return { ok: true };
    });
  }

  async updateSettings(settings: SettingsInput) {
    if (!isAbsolute(settings.downloadPath)) {
      throw new UserError("Le dossier doit être un chemin absolu", { status: 400 });
    }
    const destination = this.destinations.get("default");
    if (destination) {
      await this.saveDestination("default", {
        downloadPath: settings.downloadPath,
        moveFiles: settings.moveFiles,
        name: destination.name,
      });
    }
    Object.assign(this.settings, {
      downloadLimit: settings.downloadLimit,
      downloadPath: resolvePath(settings.downloadPath),
      runInBackground: settings.runInBackground ?? this.settings.runInBackground,
      uploadLimit: settings.uploadLimit,
    });
    this.client.throttleDownload(settings.downloadLimit);
    this.client.throttleUpload(settings.uploadLimit);
    this.config("settings", this.settings);
    await this.diskSpace();
    return this.settings;
  }

  reannounce(id: string) {
    const entry = this.get(id);
    if (!entry.torrent || entry.paused) {
      throw new UserError("Reprenez le torrent avant d'actualiser ses trackers", { status: 409 });
    }
    if (!announce(entry.torrent)) {
      throw new UserError("La connexion aux trackers n'est pas encore prête", { status: 409 });
    }
    for (const row of entry.detail.trackers) {
      row.status = "announcing";
    }
    return { ok: true };
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new UserError("Torrent introuvable", { status: 404 });
    }
    return entry;
  }

  private summary(entry: Entry): TorrentDetail {
    const { torrent, detail } = entry;
    detail.status = entryStatus(entry);
    detail.downloadSpeed = torrent?.downloadSpeed ?? 0;
    detail.uploadSpeed = torrent?.uploadSpeed ?? 0;
    detail.peers = torrent?.numPeers ?? 0;
    if (torrent?.ready) {
      detail.name = torrent.name;
      detail.length = torrent.length;
      detail.downloaded = torrent.downloaded;
      detail.progress = detail.length > 0 ? detail.downloaded / detail.length : 0;
      detail.eta =
        detail.downloadSpeed > 0
          ? (detail.length - detail.downloaded) / detail.downloadSpeed
          : null;
      detail.seeds = torrent.wires.filter(
        (wire) => (wire as typeof wire & { isSeeder?: boolean }).isSeeder
      ).length;
    }
    const seeds = detail.trackers.flatMap((row) => (row.seeds === null ? [] : [row.seeds]));
    const leeches = detail.trackers.flatMap((row) => (row.leeches === null ? [] : [row.leeches]));
    detail.swarmSeeds = seeds.length ? Math.max(...seeds) : null;
    detail.swarmPeers = leeches.length ? Math.max(...leeches) : null;
    if (!torrent) {
      detail.peerList = [];
      detail.seeds = 0;
    }
    if (entry.paused) {
      for (const row of detail.trackers) {
        row.status = "paused";
      }
    }
    detail.ratio = detail.downloaded > 0 ? detail.uploaded / detail.downloaded : null;
    return detail;
  }

  private details(entry: Entry): TorrentDetail {
    const detail = this.summary(entry);
    const { torrent } = entry;
    if (torrent?.ready) {
      detail.comment = torrent.comment || "";
      detail.createdBy = torrent.createdBy || "";
      detail.pieceLength = torrent.pieceLength;
      detail.pieces = torrent.pieces.length;
      const pieces = torrent.pieces as (Torrent["pieces"][number] | null)[];
      detail.verifiedPieces = pieces.filter((piece) => piece === null).length;
      detail.pieceMap = Array.from({ length: Math.min(100, torrent.pieces.length) }, (_, bin) => {
        const from = Math.floor(
          (bin * torrent.pieces.length) / Math.min(100, torrent.pieces.length)
        );
        const to = Math.floor(
          ((bin + 1) * torrent.pieces.length) / Math.min(100, torrent.pieces.length)
        );
        let verified = 0;
        for (let index = from; index < to; index += 1) {
          if (torrent.pieces[index] === null) {
            verified += 1;
          }
        }
        return verified / (to - from);
      });
      const priorities = new Map(detail.files.map((file) => [file.path, file.priority]));
      detail.files = torrent.files.map((file, index) => ({
        downloaded: file.done ? file.length : file.downloaded,
        index,
        length: file.length,
        name: file.name,
        path: file.path,
        priority: priorities.get(file.path) ?? "normal",
        progress: file.done ? 1 : file.progress,
      }));
      detail.peerList = peers(torrent);
      detail.seeds = detail.peerList.filter((peer) => peer.progress === 1).length;
    }
    return detail;
  }

  detail(id: string) {
    return this.details(this.get(id));
  }

  snapshot(selected: string | null, includeDetail?: boolean): DashboardState {
    const entries = [...this.entries.values()];
    const details = entries.map((entry) => this.summary(entry));
    const chosen = selected ? this.entries.get(selected) : entries[0];
    return {
      destinations: [...this.destinations.values()],
      detail: includeDetail !== false && chosen ? this.details(chosen) : null,
      history: [...this.history],
      session: {
        active: details.filter((detail) => !["paused", "error"].includes(detail.status)).length,
        dhtNodes:
          (this.client.dht as { nodes?: { count: () => number } } | null)?.nodes?.count() ?? 0,
        downloadSpeed: this.client.downloadSpeed,
        engine: WebTorrent.VERSION,
        freeSpace: this.freeSpace,
        mode: this.mode,
        peers: details.reduce((sum, detail) => sum + detail.peers, 0),
        port: this.client.torrentPort,
        received: this.received,
        startedAt: this.startedAt,
        uploaded: this.uploaded,
        uploadSpeed: this.client.uploadSpeed,
      },
      settings: this.settings,
      torrents: details.map(
        ({
          savePath,
          magnet,
          comment,
          createdBy,
          private: isPrivate,
          pieceLength,
          pieces,
          verifiedPieces,
          pieceMap,
          activeSeconds,
          seedSeconds,
          lastTransferAt,
          files,
          trackers,
          peerList,
          ...summary
        }) => summary
      ),
    };
  }

  async file(id: string, index: number) {
    const entry = this.get(id);
    const detail = this.details(entry);
    if (detail.status === "checking" || entry.verifying) {
      throw new UserError(
        "Les fichiers sont en cours de vérification. Réessayez une fois la vérification terminée.",
        { status: 409 }
      );
    }
    if (entry.moving) {
      throw new UserError("Les fichiers sont en cours de déplacement. Réessayez ensuite.", {
        status: 409,
      });
    }
    const file = detail.files[index];
    if (!file) {
      throw new UserError("Fichier introuvable", { status: 404 });
    }
    if (file.progress !== 1) {
      throw new UserError("Le téléchargement de ce fichier n'est pas terminé", { status: 409 });
    }
    const path = this.storagePath(detail.savePath, file.path);
    if (!(await Bun.file(path).exists())) {
      throw new UserError(`Le fichier téléchargé n’est plus présent : ${path}`, { status: 404 });
    }
    return { name: file.name, path };
  }

  async close() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: subsequent calls observe the assignment below; closing must be idempotent.
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    await this.destinationOperation?.catch(() => undefined);
    await Promise.all(
      [...this.entries.values()].map((entry) => entry.operation.catch(() => undefined))
    );
    for (const entry of this.entries.values()) {
      this.details(entry);
      entry.unwatch?.();
    }
    if (!this.client.destroyed) {
      await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
    }
    for (const entry of this.entries.values()) {
      this.save(entry);
    }
    this.config("traffic", { received: this.received, uploaded: this.uploaded });
    this.db.close();
  }
}
