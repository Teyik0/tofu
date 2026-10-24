import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { ElysiaStatus, HTTPError, problem } from "elysia";
import { createLogger } from "evlog";
import type { logDrain } from "../../../../evlog.config";
import workerBundle from "../../../../runtime/engine-worker.worker" with { type: "file" };
import type { DestinationInput, DestinationPresentation } from "../destinations/model";
import type { SettingsInput } from "../settings/model";
import type { EngineOpenOptions, TorrentAddOptions } from "./service";
import type { DashboardState, EngineChange, EngineSnapshot, FilePriority } from "./types";
import type { EngineMessage, EngineOperations, EngineRequest } from "./worker-protocol";

interface PendingOperation {
  method: EngineRequest["method"];
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

export class WorkerTorrentEngine extends EventEmitter<{ change: [EngineChange] }> {
  private readonly worker: Worker;
  private readonly options: EngineOpenOptions;
  private readonly logs?: typeof logDrain;
  private readonly pending = new Map<number, PendingOperation>();
  private readonly ready = Promise.withResolvers<void>();
  private state!: DashboardState;
  private currentStateRevision = 0;
  private currentTelemetryRevision = 0;
  private sampledAt = 0;
  private refresh: Promise<
    DashboardState | ReturnType<typeof problem<503, { detail: string }>>
  > | null = null;
  private sequence = 0;
  private failure: Error | null = null;
  private shutdown: Promise<void> | null = null;
  mode: "desktop" | "server" = "server";

  private constructor(entry: string | URL, options: EngineOpenOptions, logs?: typeof logDrain) {
    super();
    // Every open live stream listens for changes.
    this.setMaxListeners(0);
    this.options = options;
    this.logs = logs;
    this.worker = new Worker(entry);
    this.worker.addEventListener("message", ({ data }: MessageEvent<EngineMessage>) => {
      if (data.type === "log") {
        this.logs?.(data.context);
        return;
      }
      if (data.type === "ready") {
        this.ready.resolve();
        return;
      }
      if (data.type === "snapshot") {
        this.receive(data.snapshot);
        return;
      }
      const operation = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.type === "failure") {
        operation?.resolve(new ElysiaStatus(data.status, data.body, data.headers));
      } else if (data.type === "error") {
        const { failure } = data;
        operation?.reject(
          failure.kind === "http"
            ? new (HTTPError.id(failure.code, failure.status))(failure.message)
            : new Error(failure.message)
        );
      } else {
        if (data.snapshot) {
          this.receive(data.snapshot);
        }
        operation?.resolve(data.value);
      }
    });
    this.worker.addEventListener("error", (event) =>
      this.fail(new Error(event.message, { cause: event.error }))
    );
    this.worker.addEventListener("close", (event) =>
      this.fail(
        new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("The torrent engine has stopped"),
        "code" in event && typeof event.code === "number" ? event.code : undefined
      )
    );
  }

  private receive(snapshot: EngineSnapshot) {
    const structural = snapshot.stateRevision !== this.currentStateRevision;
    const telemetry = snapshot.telemetryRevision !== this.currentTelemetryRevision;
    this.state = snapshot.state;
    this.sampledAt = snapshot.sampledAt;
    this.currentStateRevision = snapshot.stateRevision;
    this.currentTelemetryRevision = snapshot.telemetryRevision;
    if (structural || telemetry) {
      this.emit("change", {
        kind: structural ? "state" : "telemetry",
        stateRevision: this.currentStateRevision,
        telemetryRevision: this.currentTelemetryRevision,
      });
    }
  }

  get stateRevision() {
    return this.currentStateRevision;
  }

  get telemetryRevision() {
    return this.currentTelemetryRevision;
  }

  refreshSnapshot(maxAgeMs: number) {
    if (this.failure) {
      return Promise.resolve(problem(503, { detail: "The torrent engine has stopped" }));
    }
    if (maxAgeMs > 0 && Date.now() - this.sampledAt <= maxAgeMs) {
      return Promise.resolve(this.snapshot(null, false));
    }
    if (!this.refresh) {
      const pending = Promise.withResolvers<
        DashboardState | ReturnType<typeof problem<503, { detail: string }>>
      >();
      this.refresh = pending.promise;
      const refresh = async () => {
        try {
          const result = await this.call("refreshSnapshot", [0]);
          pending.resolve(result instanceof ElysiaStatus ? result : this.snapshot(null, false));
        } catch (error) {
          pending.reject(error);
        } finally {
          this.refresh = null;
        }
      };
      void refresh();
      return pending.promise;
    }
    return this.refresh;
  }

  setObserved(observed: boolean) {
    return this.call("setObserved", [observed]);
  }

  static async open(options: EngineOpenOptions, logs?: typeof logDrain) {
    const source = new URL("./worker.ts", import.meta.url);
    const compiled = new URL(workerBundle, import.meta.url);
    // The native host shares the backend's worker and external package tree.
    const artifact = new URL(`../furin/${workerBundle}`, import.meta.url);
    const entry = [source, artifact, compiled].find((candidate) => existsSync(candidate));
    if (!entry) {
      throw new Error("The torrent worker entrypoint is missing");
    }
    const engine = new WorkerTorrentEngine(entry, options, logs);
    try {
      await engine.ready.promise;
      await engine.send({
        args: [
          {
            ...options,
            cryptoDiagnostics:
              options.cryptoDiagnostics ?? process.env.TOFU_CRYPTO_DIAGNOSTICS === "1",
          },
        ],
        id: engine.nextId(),
        method: "open",
      });
      return engine;
    } catch (error) {
      engine.worker.terminate();
      await logs?.flush();
      throw error;
    }
  }

  private fail(error: Error, exitCode?: number) {
    // Bun can emit error followed by close; keep the original exception and its stack.
    if (this.failure) {
      return;
    }
    if (!this.shutdown) {
      const log = createLogger({
        component: "torrent-worker",
        context: {
          exitCode,
          pendingOperations: [...this.pending.values()].map((operation) => operation.method),
        },
        dataDir: this.options.dataDir,
        error,
        operation: "stopped",
      });
      log.setLevel("error");
      log.emit();
    }
    this.failure = error;
    this.ready.reject(error);
    for (const operation of this.pending.values()) {
      operation.reject(error);
    }
    this.pending.clear();
  }
  private nextId() {
    this.sequence += 1;
    return this.sequence;
  }

  private send(request: EngineRequest): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { method: request.method, reject, resolve });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        reject(error);
      }
    });
  }

  private call<Method extends keyof EngineOperations>(
    method: Method,
    args: Parameters<EngineOperations[Method]>
  ) {
    if (this.shutdown || this.failure) {
      return Promise.resolve(problem(503, { detail: "The torrent engine is unavailable" }));
    }
    return this.send({ args, id: this.nextId(), method } as EngineRequest) as Promise<
      Awaited<ReturnType<EngineOperations[Method]>>
    >;
  }

  get settings() {
    return this.state.settings;
  }

  snapshot(_selected: string | null, _includeDetail?: boolean): DashboardState {
    if (this.failure) {
      throw this.failure;
    }
    return { ...this.state, session: { ...this.state.session, mode: this.mode } };
  }

  assertReady() {
    return this.call("assertReady", []);
  }

  connectionDiagnostics() {
    return this.call("connectionDiagnostics", []);
  }

  add(input: string | Uint8Array, options: TorrentAddOptions) {
    return this.call("add", [input, options]);
  }
  addPeer(id: string, peer: string) {
    return this.call("addPeer", [id, peer]);
  }
  detail(id: string) {
    return this.call("detail", [id]);
  }
  file(id: string, index: number) {
    return this.call("file", [id, index]);
  }
  waitForRange(request: string, id: string, index: number, start: number, end: number) {
    return this.call("waitForRange", [request, id, index, start, end]);
  }
  cancelRange(request: string) {
    return this.call("cancelRange", [request]);
  }
  cancelRanges(id?: string) {
    return this.call("cancelRanges", [id]);
  }
  locate(id: string, downloadPath: string) {
    return this.call("locate", [id, downloadPath]);
  }
  pause(id: string) {
    return this.call("pause", [id]);
  }
  priority(id: string, index: number, priority: FilePriority) {
    return this.call("priority", [id, index, priority]);
  }
  reannounce(id: string) {
    return this.call("reannounce", [id]);
  }
  repair(id: string) {
    return this.call("repair", [id]);
  }
  remove(id: string, deleteFiles: boolean, operationKey?: string) {
    return this.call("remove", [id, deleteFiles, operationKey]);
  }
  removeDestination(id: string) {
    return this.call("removeDestination", [id]);
  }
  replaceTrackers(id: string, urls: string[]) {
    return this.call("replaceTrackers", [id, urls]);
  }
  resume(id: string) {
    return this.call("resume", [id]);
  }
  saveDestination(id: string | null, input: DestinationInput) {
    return this.call("saveDestination", [id, input]);
  }
  updateDestinationPresentation(id: string, input: DestinationPresentation) {
    return this.call("updateDestinationPresentation", [id, input]);
  }
  updateSettings(settings: SettingsInput) {
    return this.call("updateSettings", [settings]);
  }
  verify(id: string) {
    return this.call("verify", [id]);
  }

  close() {
    if (!this.shutdown) {
      const pending = Promise.withResolvers<void>();
      this.shutdown = pending.promise;
      const close = async () => {
        try {
          await this.send({ args: [], id: this.nextId(), method: "close" });
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        } finally {
          this.worker.terminate();
        }
      };
      void close();
    }
    return this.shutdown;
  }
}
