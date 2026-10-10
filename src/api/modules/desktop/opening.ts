import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import parseTorrent from "parse-torrent";
import type { EnginePort } from "../../../types";
import { UserError } from "../../lib/errors";

export class DesktopUrlOpener {
  private readonly torrents: DesktopTorrentOpener;
  private readonly authorize: (url: string) => Promise<unknown>;
  private readonly show: () => void;
  private readonly readiness: Promise<void>;
  private markReady!: () => void;

  constructor(options: {
    engine: () => EnginePort;
    show: () => void;
    authorize: (url: string) => Promise<unknown>;
  }) {
    this.torrents = new DesktopTorrentOpener(options);
    this.authorize = options.authorize;
    this.show = options.show;
    this.readiness = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  ready() {
    this.torrents.ready();
    this.markReady();
  }

  async open(input: string) {
    await this.readiness;
    if (["tofu:", "tofu-dev:"].includes(new URL(input).protocol)) {
      this.show();
      return this.authorize(input);
    }
    return this.torrents.open(input);
  }
}

// Native events can arrive while the engine is still restoring its library.
export class DesktopTorrentOpener {
  private readonly engine: () => EnginePort;
  private readonly show: () => void;
  private readonly readiness: Promise<void>;
  private markReady!: () => void;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { engine: () => EnginePort; show: () => void }) {
    this.engine = options.engine;
    this.show = options.show;
    this.readiness = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  ready() {
    this.markReady();
  }

  open(input: string) {
    const operation = this.pending.then(async () => {
      await this.readiness;
      const url = new URL(input);
      let source: string | Uint8Array;
      if (url.protocol === "magnet:") {
        source = input;
      } else if (url.protocol === "file:") {
        const path = fileURLToPath(url);
        if (extname(path).toLowerCase() !== ".torrent") {
          throw new UserError("Only .torrent files can be opened", { status: 400 });
        }
        const file = Bun.file(path);
        if (file.size > 8 * 1024 * 1024) {
          throw new UserError("The torrent file is too large", { status: 400 });
        }
        source = new Uint8Array(await file.arrayBuffer());
      } else {
        throw new UserError("Only magnet links and .torrent files can be opened", { status: 400 });
      }
      const parsed = await parseTorrent(source);
      const engine = this.engine();
      this.show();
      // Reopening an existing torrent must preserve its destination and paused state.
      if (engine.snapshot(null, false).torrents.some((torrent) => torrent.id === parsed.infoHash)) {
        return engine.detail(parsed.infoHash);
      }
      return engine.add(source, { paused: false });
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
