/**
 * Minimal transmission-daemon RPC fixture. It implements the subset Tofu uses, including the
 * 409 session-id challenge and optional HTTP Basic authentication, so tests never reach a real
 * daemon.
 */
export interface TransmissionFixture {
  calls: string[];
  deleted: { deleteLocalData: boolean; ids: number[] }[];
  files: { unwanted: number[][]; wanted: number[][] };
  torrents: Record<string, unknown>[];
  url: string;
  [Symbol.dispose]: () => void;
}

interface FixtureOptions {
  password?: string;
  username?: string;
}

const SESSION = {
  "alt-speed-enabled": false,
  "download-dir": "/downloads",
  "idle-seeding-limit": 30,
  "idle-seeding-limit-enabled": false,
  "peer-limit-global": 1000,
  "peer-limit-per-torrent": 50,
  "rpc-version": 15,
  seedRatioLimit: 2,
  seedRatioLimited: false,
  "speed-limit-down": 0,
  "speed-limit-down-enabled": false,
  "speed-limit-up": 0,
  "speed-limit-up-enabled": false,
  version: "2.83 (30)",
};

function torrent(id: number, status: number) {
  return {
    addedDate: 1_700_000_000,
    bandwidthPriority: 0,
    comment: "Fixture comment",
    creator: "Fixture",
    dateCreated: 1_699_000_000,
    doneDate: status === 6 ? 1_700_000_100 : 0,
    downloadDir: "/downloads",
    downloadedEver: 250,
    downloadLimit: 0,
    downloadLimited: false,
    error: 0,
    errorString: "",
    eta: status === 4 ? 120 : -1,
    fileStats: [
      { priority: 0, wanted: true },
      { priority: 0, wanted: true },
    ],
    files: [
      { bytesCompleted: 250, length: 1000, name: "example.bin" },
      { bytesCompleted: 0, length: 500, name: "extra.bin" },
    ],
    hashString: `${id}`.padStart(40, "b"),
    honorsSessionLimits: true,
    id,
    isFinished: status === 6,
    isPrivate: false,
    magnetLink: `magnet:?xt=urn:btih:${id}`.padEnd(60, "0"),
    name: `Example ${id}`,
    peers: [
      {
        address: "203.0.113.5:51413",
        clientName: "Transmission 2.83",
        isDownloadingFrom: true,
        isEncrypted: true,
        isIncoming: false,
        isUploadingTo: false,
        peerIsChoked: false,
        peerIsInterested: true,
        progress: 0.5,
        rateToClient: 2048,
        rateToPeer: 0,
      },
    ],
    peersConnected: 2,
    peersGettingFromUs: 0,
    peersSendingToUs: 2,
    percentDone: 0.25,
    pieceCount: 2,
    pieceSize: 1024,
    queuePosition: 0,
    rateDownload: 1024,
    rateUpload: 0,
    secondsDownloading: 3600,
    secondsSeeding: 0,
    seedIdleLimit: 30,
    seedIdleMode: 0,
    seedRatioLimit: 2,
    seedRatioMode: 0,
    sizeWhenDone: 1500,
    status,
    totalSize: 1500,
    trackerStats: [
      {
        announce: "udp://tracker.example:1337",
        id: 0,
        lastAnnounceResult: "Success",
        lastAnnounceSucceeded: true,
        leecherCount: 1,
        seederCount: 4,
        tier: 0,
      },
    ],
    trackers: [{ announce: "udp://tracker.example:1337", id: 0, tier: 0 }],
    uploadedEver: 0,
    uploadLimit: 0,
    uploadLimited: false,
    uploadRatio: -1,
  };
}

function selectedIds(args: Record<string, unknown>) {
  return Array.isArray(args.ids) ? (args.ids as number[]) : [];
}

export function transmissionServer(options?: FixtureOptions): TransmissionFixture {
  const session: Record<string, unknown> = { ...SESSION };
  const torrents: Record<string, unknown>[] = [torrent(1, 4)];
  const calls: string[] = [];
  const deleted: { deleteLocalData: boolean; ids: number[] }[] = [];
  const files: { unwanted: number[][]; wanted: number[][] } = { unwanted: [], wanted: [] };
  const sessionId = crypto.randomUUID();
  let nextId = 2;
  const expected =
    options?.username === undefined
      ? null
      : `Basic ${Buffer.from(`${options.username}:${options.password ?? ""}`, "utf8").toString("base64")}`;

  function setStatus(args: Record<string, unknown>, status: number) {
    const ids = selectedIds(args);
    for (const item of torrents) {
      if (ids.includes(item.id as number)) {
        item.status = status;
      }
    }
    return {};
  }

  function add(args: Record<string, unknown>) {
    const id = nextId;
    nextId += 1;
    const added = torrent(id, args.paused === true ? 0 : 4);
    torrents.push(added);
    return { "torrent-added": { hashString: added.hashString, id, name: added.name } };
  }

  function get(args: Record<string, unknown>) {
    const ids = selectedIds(args);
    return {
      torrents:
        ids.length === 0 ? torrents : torrents.filter((item) => ids.includes(item.id as number)),
    };
  }

  function remove(args: Record<string, unknown>) {
    const ids = selectedIds(args);
    deleted.push({ deleteLocalData: args["delete-local-data"] === true, ids });
    for (const id of ids) {
      const index = torrents.findIndex((item) => item.id === id);
      if (index >= 0) {
        torrents.splice(index, 1);
      }
    }
    return {};
  }

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    "session-get": () => session,
    "session-set": (args) => {
      Object.assign(session, args);
      return {};
    },
    "session-stats": () => ({
      activeTorrentCount: torrents.filter((item) => item.status !== 0).length,
      downloadSpeed: 1024,
      pausedTorrentCount: torrents.filter((item) => item.status === 0).length,
      torrentCount: torrents.length,
      uploadSpeed: 0,
    }),
    "torrent-add": add,
    "torrent-get": get,
    "torrent-reannounce": () => ({}),
    "torrent-remove": remove,
    "torrent-set": (args) => {
      files.wanted.push(args["files-wanted"] as number[]);
      files.unwanted.push(args["files-unwanted"] as number[]);
      return {};
    },
    "torrent-start": (args) => setStatus(args, 4),
    "torrent-start-now": (args) => setStatus(args, 4),
    "torrent-stop": (args) => setStatus(args, 0),
    "torrent-verify": () => ({}),
  };

  const server = Bun.serve({
    fetch: async (request) => {
      if (expected !== null && request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.headers.get("x-transmission-session-id") !== sessionId) {
        return new Response("Conflict", {
          headers: { "x-transmission-session-id": sessionId },
          status: 409,
        });
      }
      const body = (await request.json()) as {
        arguments?: Record<string, unknown>;
        method: string;
      };
      const { method } = body;
      const args = body.arguments ?? {};
      calls.push(method);
      const handler = handlers[method];
      if (handler === undefined) {
        return Response.json({ result: "method not recognized" });
      }
      return Response.json({ arguments: handler(args), result: "success" });
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  return {
    calls,
    deleted,
    files,
    torrents,
    url: `http://127.0.0.1:${server.port}`,
    [Symbol.dispose]: () => server.stop(true),
  };
}
