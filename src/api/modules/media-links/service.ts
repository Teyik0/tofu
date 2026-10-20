import "@teyik0/furin/server-only";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { ElysiaStatus, problem } from "elysia";
import { authorizedDevices, mediaLinks } from "../../../db/schema";
import type { EnginePort } from "../../../types";
import type { TofuDatabase } from "../../lib/db";

const DEFAULT_TTL = 6 * 3_600_000;

interface MediaLinksOptions {
  db: TofuDatabase;
  now: () => number;
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * File-scoped, expiring, revocable playback links for players that cannot send this server's
 * session: external players and linked Tofu servers. Holding a link grants Range reads of one
 * file until it expires, is revoked, or its issuing device loses access.
 */
export class MediaLinks {
  private readonly options: MediaLinksOptions;
  private readonly readers = new Map<string, { controller: AbortController; count: number }>();

  constructor(options: MediaLinksOptions) {
    this.options = options;
  }

  issue(input: {
    deviceId: string | null;
    file: { index: number; length: number; name: string };
    torrentId: string;
  }) {
    const now = this.options.now();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const link = {
      createdAt: now,
      deviceId: input.deviceId,
      expiresAt: now + DEFAULT_TTL,
      fileIndex: input.file.index,
      fileLength: input.file.length,
      fileName: input.file.name,
      id: crypto.randomUUID(),
      revokedAt: null,
      tokenHash: hash(token),
      torrentId: input.torrentId,
    };
    this.options.db.insert(mediaLinks).values(link).run();
    return {
      expiresAt: link.expiresAt,
      id: link.id,
      path: `/media/x/${token}/${encodeURIComponent(input.file.name)}`,
    };
  }

  /** Issues a link to one file of a torrent after checking that the file exists. */
  async issueForFile(
    engine: EnginePort,
    input: { deviceId: string | null; fileIndex: number; torrentId: string }
  ) {
    const detail = await engine.detail(input.torrentId);
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    const file = detail.files[input.fileIndex];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    const link = this.issue({
      deviceId: input.deviceId,
      file: { index: file.index, length: file.length, name: file.name },
      torrentId: input.torrentId,
    });
    return {
      ...link,
      file: {
        complete: file.progress === 1,
        index: file.index,
        length: file.length,
        name: file.name,
      },
    };
  }

  /** The file a live token grants, checked against the identity it was issued for. */
  async describe(engine: EnginePort, token: string) {
    const link = this.resolve(token);
    if (!link) {
      return problem(404, { detail: "This playback link expired or was revoked" });
    }
    const detail = await engine.detail(link.torrentId);
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    const file = detail.files[link.fileIndex];
    if (!file || file.length !== link.fileLength) {
      return problem(404, { detail: "This playback link expired or was revoked" });
    }
    return file;
  }

  /** The live grant behind a token, or null once expired, revoked or orphaned. */
  resolve(token: string) {
    const now = this.options.now();
    const row = this.options.db
      .select({ device: authorizedDevices, link: mediaLinks })
      .from(mediaLinks)
      .leftJoin(authorizedDevices, eq(authorizedDevices.id, mediaLinks.deviceId))
      .where(
        and(
          eq(mediaLinks.tokenHash, hash(token)),
          isNull(mediaLinks.revokedAt),
          gt(mediaLinks.expiresAt, now)
        )
      )
      .get();
    if (!row || (row.link.deviceId !== null && (!row.device || row.device.revokedAt !== null))) {
      return null;
    }
    return row.link;
  }

  read(id: string, expiresAt: number) {
    let active = this.readers.get(id);
    if (!active) {
      active = { controller: new AbortController(), count: 0 };
      this.readers.set(id, active);
    }
    active.count += 1;
    const signal = AbortSignal.any([
      active.controller.signal,
      AbortSignal.timeout(Math.max(0, expiresAt - this.options.now())),
    ]);
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        active.count -= 1;
        if (active.count === 0 && this.readers.get(id) === active) {
          this.readers.delete(id);
        }
      },
      signal,
    };
  }

  revoke(deviceId: string | null, id: string) {
    const link = this.options.db.select().from(mediaLinks).where(eq(mediaLinks.id, id)).get();
    if (!link || link.deviceId !== deviceId) {
      return problem(404, { detail: "Playback link not found" });
    }
    this.options.db
      .update(mediaLinks)
      .set({ revokedAt: this.options.now() })
      .where(eq(mediaLinks.id, id))
      .run();
    this.readers.get(id)?.controller.abort();
    this.readers.delete(id);
    return { revoked: true as const };
  }

  prune() {
    const now = this.options.now();
    this.options.db
      .delete(mediaLinks)
      .where(or(lt(mediaLinks.expiresAt, now), lt(mediaLinks.revokedAt, now - 86_400_000)))
      .run();
  }
}
