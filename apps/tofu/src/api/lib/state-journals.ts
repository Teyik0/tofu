import { invalidateSync, type SyncRuntimeOptions } from "@teyik0/furin/sync";
import { Cause, Context, Duration, Effect, Layer, Queue, Schedule, Scope } from "effect";
import { createLogger } from "evlog";
import { nativeControl } from "../../native/control";
import { TorrentClient } from "../modules/torrents/layer";
import { instance } from "./instance";

const retry = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(2000)))
  )
);

const make = Effect.gen(function* () {
  const torrents = yield* TorrentClient;
  const scope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let workspaceStarted = false;
  let remoteStarted = false;

  const startWorkspace = Effect.fn("StateJournals.startWorkspace")(function* (
    sync: SyncRuntimeOptions
  ) {
    if (workspaceStarted) {
      return;
    }
    workspaceStarted = true;
    const wake = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
    const changed = () => {
      Queue.offerUnsafe(wake, undefined);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => torrents.on("change", changed)),
      () =>
        Effect.sync(() => {
          torrents.off("change", changed);
        })
    );

    const publish = Effect.tryPromise({
      catch: (error) => error,
      try: () => invalidateSync(sync, "/api/state"),
    }).pipe(
      // Finish an in-flight database write before the dependency scope closes.
      Effect.uninterruptible,
      Effect.tapError((error) =>
        Effect.sync(() => {
          const log = createLogger({
            component: "torrent-sync",
            dataDir: instance.dataDir,
            error,
            operation: "invalidate-state",
          });
          log.setLevel("error");
          log.emit();
        })
      ),
      Effect.retry(retry)
    );
    yield* Effect.forkIn(
      Effect.forever(Effect.andThen(Queue.take(wake), publish)).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) {
              return;
            }
            const log = createLogger({
              component: "torrent-sync",
              dataDir: instance.dataDir,
              error: Cause.squash(cause),
              operation: "journal-stopped",
            });
            log.setLevel("error");
            log.emit();
          })
        )
      ),
      scope
    );
  }, Scope.provide(scope));

  const startRemote = Effect.fn("StateJournals.startRemote")(function* (sync: SyncRuntimeOptions) {
    const remote = nativeControl.tofuNativeThreads;
    if (!remote || remoteStarted) {
      return;
    }
    remoteStarted = true;
    const tasks = yield* Scope.fork(scope, "parallel");
    const pending = new Map<string, { revision: number }>();
    let closing = false;
    const changed = (serverId: unknown) => {
      if (closing || typeof serverId !== "string") {
        return;
      }
      const existing = pending.get(serverId);
      if (existing) {
        existing.revision += 1;
        return;
      }
      // Reserve the server before scheduling its fiber so synchronous bursts coalesce.
      const entry = { revision: 0 };
      pending.set(serverId, entry);
      const task = Effect.gen(function* () {
        let published = -1;
        while (published !== entry.revision) {
          const current = entry.revision;
          yield* Effect.tryPromise({
            catch: (error) => error,
            try: () => invalidateSync(sync, "/api/desktop/servers/:id/state", { id: serverId }),
          }).pipe(
            Effect.uninterruptible,
            Effect.tapError((error) =>
              Effect.sync(() => {
                const log = createLogger({
                  component: "desktop-sync",
                  context: { serverId },
                  dataDir: instance.dataDir,
                  error,
                  operation: "invalidate-remote-state",
                });
                log.setLevel("error");
                log.emit();
              })
            ),
            Effect.retry(retry)
          );
          published = current;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(serverId);
          })
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) {
              return;
            }
            const log = createLogger({
              component: "desktop-sync",
              context: { serverId },
              dataDir: instance.dataDir,
              error: Cause.squash(cause),
              operation: "journal-stopped",
            });
            log.setLevel("error");
            log.emit();
          })
        )
      );
      runFork(Effect.forkIn(task, tasks));
    };

    yield* Effect.addFinalizer(() => Effect.promise(() => remote.close()));
    yield* Effect.acquireRelease(
      Effect.sync(() => remote.on("change", changed)),
      () =>
        Effect.sync(() => {
          closing = true;
          remote.off("change", changed);
        })
    );
    yield* Effect.sync(() => remote.start());
  }, Scope.provide(scope));

  return { startRemote, startWorkspace };
});

export class StateJournals extends Context.Service<StateJournals, Effect.Success<typeof make>>()(
  "tofu/state-journals"
) {}

export const stateJournalsLayer = Layer.effect(StateJournals, make);
