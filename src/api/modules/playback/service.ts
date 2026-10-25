import "@teyik0/furin/server-only";
import { and, eq } from "drizzle-orm";
import { type Cause, Context, Effect, Layer } from "effect";
import { playbackPositions, playbackSequences } from "../../../db/schema";
import { Database } from "../../lib/database-layer";
import type { PositionInput } from "./model";

export class Playback extends Context.Service<
  Playback,
  {
    readonly readPosition: (
      profileId: string,
      mediaKey: string
    ) => Effect.Effect<
      { duration: number | null; position: number | null; updatedAt: number | null },
      Cause.UnknownError
    >;
    readonly recordPosition: (
      profileId: string,
      mediaKey: string,
      input: PositionInput
    ) => Effect.Effect<{ accepted: boolean; position: number }, Cause.UnknownError>;
  }
>()("tofu/playback") {}

const make = Effect.gen(function* () {
  const db = yield* Database;

  const readPosition = Effect.fn("Playback.readPosition")(function* (
    profileId: string,
    mediaKey: string
  ) {
    const row = yield* Effect.try(() =>
      db
        .select()
        .from(playbackPositions)
        .where(
          and(eq(playbackPositions.profileId, profileId), eq(playbackPositions.mediaKey, mediaKey))
        )
        .get()
    );
    return row
      ? { duration: row.duration, position: row.position, updatedAt: row.updatedAt }
      : { duration: null, position: null, updatedAt: null };
  });

  /**
   * Records a profile's position. Within one player session only newer sequence numbers apply;
   * across sessions the latest write wins, so seeking backwards on purpose is kept.
   */
  const recordPosition = Effect.fn("Playback.recordPosition")(function* (
    profileId: string,
    mediaKey: string,
    input: PositionInput
  ) {
    return yield* Effect.try(() =>
      db.transaction((tx) => {
        const current = tx
          .select()
          .from(playbackPositions)
          .where(
            and(
              eq(playbackPositions.profileId, profileId),
              eq(playbackPositions.mediaKey, mediaKey)
            )
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
      })
    );
  });
  return { readPosition, recordPosition };
});

export const playbackLayer = Layer.effect(Playback, make);
