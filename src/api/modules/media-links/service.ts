import { Context, Effect, Layer } from "effect";
import "@teyik0/furin/server-only";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { ElysiaStatus, problem } from "elysia";
import { authorizedDevices, mediaLinks } from "../../../db/schema";
import { Database } from "../../lib/db";
import type { EnginePort } from "../torrents/service";
import type { FileStats } from "../torrents/types";

const DEFAULT_TTL = 6 * 3_600_000;

interface MediaLinksOptions {
  db: Database["Service"];
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
const make = Effect.gen(function* () {
  const db = yield* Database;
  const options: MediaLinksOptions = { db, now: Date.now };

  const serviceOptions = options;

  const serviceReaders = new Map<string, { controller: AbortController; count: number }>();
  function serviceIssue(input: {
    deviceId: string | null;
    file: { index: number; length: number; name: string };
    torrentId: string;
  }) {
    const now = serviceOptions.now();
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
    serviceOptions.db.insert(mediaLinks).values(link).run();
    return {
      expiresAt: link.expiresAt,
      id: link.id,
      path: `/media/x/${token}/${encodeURIComponent(input.file.name)}`,
    };
  }
  const serviceIssueForFile = Effect.fn("PlaybackLinks.issueForFile")(function* (
    engine: EnginePort,
    input: { deviceId: string | null; fileIndex: number; torrentId: string }
  ) {
    const detail = yield* Effect.promise(() => engine.call("detail", [input.torrentId]));
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    const file = detail.files[input.fileIndex];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    const link = serviceIssue({
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
  });
  const serviceDescribe = Effect.fn("PlaybackLinks.describe")(function* (
    engine: EnginePort,
    token: string
  ) {
    const link = serviceResolve(token);
    if (!link) {
      return problem(404, { detail: "This playback link expired or was revoked" });
    }
    const detail = yield* Effect.promise(() => engine.call("detail", [link.torrentId]));
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    const file = detail.files[link.fileIndex];
    if (!file || file.length !== link.fileLength) {
      return problem(404, { detail: "This playback link expired or was revoked" });
    }
    return file;
  });
  function serviceResolve(token: string) {
    const now = serviceOptions.now();
    const row = serviceOptions.db
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
  function serviceRead(id: string, expiresAt: number) {
    let active = serviceReaders.get(id);
    if (!active) {
      active = { controller: new AbortController(), count: 0 };
      serviceReaders.set(id, active);
    }
    active.count += 1;
    const signal = AbortSignal.any([
      active.controller.signal,
      AbortSignal.timeout(Math.max(0, expiresAt - serviceOptions.now())),
    ]);
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        active.count -= 1;
        if (active.count === 0 && serviceReaders.get(id) === active) {
          serviceReaders.delete(id);
        }
      },
      signal,
    };
  }
  function serviceRevoke(deviceId: string | null, id: string) {
    const link = serviceOptions.db.select().from(mediaLinks).where(eq(mediaLinks.id, id)).get();
    if (!link || link.deviceId !== deviceId) {
      return problem(404, { detail: "Playback link not found" });
    }
    serviceOptions.db
      .update(mediaLinks)
      .set({ revokedAt: serviceOptions.now() })
      .where(eq(mediaLinks.id, id))
      .run();
    serviceReaders.get(id)?.controller.abort();
    serviceReaders.delete(id);
    return { revoked: true as const };
  }
  function servicePrune() {
    const now = serviceOptions.now();
    serviceOptions.db
      .delete(mediaLinks)
      .where(or(lt(mediaLinks.expiresAt, now), lt(mediaLinks.revokedAt, now - 86_400_000)))
      .run();
  }

  return {
    describe: serviceDescribe,
    issue: serviceIssue,
    issueForFile: serviceIssueForFile,
    prune: servicePrune,
    read: serviceRead,
    resolve: serviceResolve,
    revoke: serviceRevoke,
  };
});

export type MediaLinks = PlaybackLinks["Service"];
export class PlaybackLinks extends Context.Service<
  PlaybackLinks,
  {
    readonly issue: (input: {
      deviceId: string | null;
      file: { index: number; length: number; name: string };
      torrentId: string;
    }) => {
      expiresAt: number;
      id: `${string}-${string}-${string}-${string}-${string}`;
      path: string;
    };
    readonly issueForFile: (
      engine: EnginePort,
      input: { deviceId: string | null; fileIndex: number; torrentId: string }
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Torrent not found" }>>
      | ReturnType<typeof problem<503, { readonly detail: "The worker is unavailable" }>>
      | ReturnType<typeof problem<503, { detail: string }>>
      | ReturnType<typeof problem<404, { readonly detail: "File not found" }>>
      | {
          file: { complete: boolean; index: number; length: number; name: string };
          expiresAt: number;
          id: `${string}-${string}-${string}-${string}-${string}`;
          path: string;
        }
    >;
    readonly describe: (
      engine: EnginePort,
      token: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Torrent not found" }>>
      | FileStats
      | ReturnType<typeof problem<503, { readonly detail: "The worker is unavailable" }>>
      | ReturnType<typeof problem<503, { detail: string }>>
      | ReturnType<
          typeof problem<404, { readonly detail: "This playback link expired or was revoked" }>
        >
    >;
    readonly resolve: (token: string) => {
      createdAt: number;
      deviceId: string | null;
      expiresAt: number;
      fileIndex: number;
      fileLength: number;
      fileName: string;
      id: string;
      revokedAt: number | null;
      tokenHash: string;
      torrentId: string;
    } | null;
    readonly read: (id: string, expiresAt: number) => { release: () => void; signal: AbortSignal };
    readonly revoke: (
      deviceId: string | null,
      id: string
    ) =>
      | ReturnType<typeof problem<404, { readonly detail: "Playback link not found" }>>
      | { revoked: true };
    readonly prune: () => void;
  }
>()("tofu/media-links") {}
export const playbackLinksLayer = Layer.effect(PlaybackLinks, make);
