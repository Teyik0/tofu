import "@teyik0/furin/server-only";
import { and, eq } from "drizzle-orm";
import { playbackPositions, playbackSequences } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";
import type { PositionInput } from "./model";

export function readPosition(db: TofuDatabase, profileId: string, mediaKey: string) {
  const row = db
    .select()
    .from(playbackPositions)
    .where(
      and(eq(playbackPositions.profileId, profileId), eq(playbackPositions.mediaKey, mediaKey))
    )
    .get();
  return row
    ? { duration: row.duration, position: row.position, updatedAt: row.updatedAt }
    : { duration: null, position: null, updatedAt: null };
}

/**
 * Records a profile's position. Within one player session only newer sequence numbers apply;
 * across sessions the latest write wins, so seeking backwards on purpose is kept.
 */
export function recordPosition(
  db: TofuDatabase,
  profileId: string,
  mediaKey: string,
  input: PositionInput
) {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(playbackPositions)
      .where(
        and(eq(playbackPositions.profileId, profileId), eq(playbackPositions.mediaKey, mediaKey))
      )
      .get();
    const sequence = tx
      .select()
      .from(playbackSequences)
      .where(
        and(
          eq(playbackSequences.profileId, profileId),
          eq(playbackSequences.mediaKey, mediaKey),
          eq(playbackSequences.sessionId, input.sessionId)
        )
      )
      .get();
    if (sequence && sequence.sequence >= input.sequence) {
      return { accepted: false, position: current?.position ?? 0 };
    }
    const now = Date.now();
    tx.insert(playbackSequences)
      .values({
        mediaKey,
        profileId,
        sequence: input.sequence,
        sessionId: input.sessionId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: { sequence: input.sequence, updatedAt: now },
        target: [
          playbackSequences.profileId,
          playbackSequences.mediaKey,
          playbackSequences.sessionId,
        ],
      })
      .run();
    const row = {
      duration: input.duration,
      mediaKey,
      position: Math.min(input.position, input.duration || input.position),
      profileId,
      sequence: input.sequence,
      sessionId: input.sessionId,
      updatedAt: now,
    };
    tx.insert(playbackPositions)
      .values(row)
      .onConflictDoUpdate({
        set: row,
        target: [playbackPositions.profileId, playbackPositions.mediaKey],
      })
      .run();
    return { accepted: true, position: row.position };
  });
}
