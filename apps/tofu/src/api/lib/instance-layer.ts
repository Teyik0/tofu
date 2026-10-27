import { Database as SQLite } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { instance } from "./instance";

export class InstanceLifetime extends Context.Service<InstanceLifetime, void>()(
  "tofu/instance-lifetime"
) {}

export const instanceLayer = Layer.effect(
  InstanceLifetime,
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(instance.dataDir, { recursive: true }));
    // A separate SQLite file holds the process lock without blocking the application's database.
    // SQLite releases its OS locks on crashes as well as on a scoped shutdown.
    const lock = yield* Effect.acquireRelease(
      Effect.try(() => new SQLite(join(instance.dataDir, "instance.lock"), { create: true })),
      (connection) => Effect.sync(() => connection.close())
    );
    yield* Effect.try({
      catch: (cause) =>
        cause instanceof Error && "code" in cause && cause.code === "SQLITE_BUSY"
          ? new Error("The application data directory is already in use", { cause })
          : cause,
      try: () => lock.run("BEGIN EXCLUSIVE"),
    });
  })
);
