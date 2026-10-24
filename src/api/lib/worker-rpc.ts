import { Effect, Result } from "effect";
import { ElysiaStatus, HTTPError, problem } from "elysia";

export type Methods = Record<string, (...args: never[]) => unknown>;

interface Request {
  args: unknown[];
  id: number;
  method: string;
  type: "request";
}
type Message =
  | { type: "ready" }
  | { type: "event"; event: string; value: unknown }
  | { type: "result"; id: number; value: unknown }
  | {
      type: "failure";
      id: number;
      status: number;
      body: unknown;
      headers: ElysiaStatus<503>["headers"];
    }
  | { type: "error"; id: number; message: string; code?: string; status?: number };

export function createWorkerClient<
  M extends Methods,
  Events extends object = Record<string, never>,
>(
  worker: Worker,
  options?: { onFailure?: (error: Error, methods: string[], exitCode?: number) => void }
) {
  const ready = Promise.withResolvers<void>();
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let sequence = 0;
  let failure: Error | null = null;
  let closed = false;

  function fail(error: Error, exitCode?: number) {
    if (failure) {
      return;
    }
    failure = error;
    ready.reject(error);
    const methods = [...pending.values()].map((operation) => operation.method);
    for (const operation of pending.values()) {
      operation.reject(error);
    }
    pending.clear();
    if (!closed) {
      options?.onFailure?.(error, methods, exitCode);
    }
  }

  const message = ({ data }: MessageEvent<Message>) => {
    if (data.type === "ready") {
      ready.resolve();
      return;
    }
    if (data.type === "event") {
      for (const listener of listeners.get(data.event) ?? []) {
        listener(data.value);
      }
      return;
    }
    const operation = pending.get(data.id);
    pending.delete(data.id);
    if (data.type === "failure") {
      operation?.resolve(new ElysiaStatus(data.status, data.body, data.headers));
    } else if (data.type === "error") {
      operation?.reject(
        data.code && data.status
          ? new (HTTPError.id(data.code, data.status))(data.message)
          : new Error(data.message)
      );
    } else {
      operation?.resolve(data.value);
    }
  };
  const onError = (event: ErrorEvent) => fail(new Error(event.message, { cause: event.error }));
  const close = (event: Event) =>
    fail(
      new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("The worker has stopped"),
      "code" in event && typeof event.code === "number" ? event.code : undefined
    );
  const messageError = () => fail(new Error("The worker sent an unreadable message"));
  worker.addEventListener("message", message);
  worker.addEventListener("error", onError);
  worker.addEventListener("close", close);
  worker.addEventListener("messageerror", messageError);

  return {
    call<K extends keyof M & string>(method: K, args: Parameters<M[K]>) {
      if (closed || failure) {
        return Promise.resolve(problem(503, { detail: "The worker is unavailable" }));
      }
      sequence += 1;
      const id = sequence;
      const operation = Promise.withResolvers<unknown>();
      pending.set(id, { method, reject: operation.reject, resolve: operation.resolve });
      const posted = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => worker.postMessage({ args, id, method, type: "request" } satisfies Request),
          })
        )
      );
      if (Result.isFailure(posted)) {
        pending.delete(id);
        operation.reject(posted.failure);
      }
      // Each response id belongs to the method and arguments reserved above.
      return operation.promise as Promise<
        Awaited<ReturnType<M[K]>> | ReturnType<typeof problem<503, { detail: string }>>
      >;
    },
    close() {
      closed = true;
      fail(new Error("The worker connection is closed"));
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("close", close);
      worker.removeEventListener("messageerror", messageError);
      listeners.clear();
      worker.terminate();
    },
    get failure() {
      return failure;
    },
    on<K extends keyof Events & string>(event: K, listener: (value: Events[K]) => void) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(listener as (value: unknown) => void);
      return () => handlers.delete(listener as (value: unknown) => void);
    },
    ready: ready.promise,
  };
}

export function serveWorker<M extends Methods, Events extends object = Record<string, never>>(
  target: Worker,
  methods: Partial<M>,
  options: {
    shutdownMethod: keyof M;
    after: (method: keyof M) => void;
    onError: (error: unknown, method: keyof M, args: unknown[]) => void;
  }
) {
  const operations = new Set<Promise<void>>();
  let closing = false;
  target.onmessage = ({ data }: MessageEvent<Request>) => {
    if (data.type !== "request") {
      return;
    }
    const shutdown = data.method === options.shutdownMethod;
    const completed = Promise.withResolvers<void>();
    if (!shutdown) {
      operations.add(completed.promise);
    }
    const unavailable = closing;
    if (shutdown) {
      closing = true;
    }
    const run = async () => {
      using completion = new DisposableStack();
      completion.defer(() => {
        operations.delete(completed.promise);
        completed.resolve();
      });
      const outcome = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            catch: (cause) => cause,
            // The worker message boundary reports unexpected runtime failures to its caller.
            try: async () => {
              const method = Object.hasOwn(methods, data.method) ? methods[data.method] : undefined;
              // The client checks the arguments against the selected method before transport.
              const value =
                unavailable || !method
                  ? problem(503, { detail: "The worker operation is unavailable" })
                  : await method(...(data.args as never[]));
              if (value instanceof ElysiaStatus) {
                target.postMessage({
                  body: value.response,
                  headers: value.headers,
                  id: data.id,
                  status: value.status,
                  type: "failure",
                } satisfies Message);
              } else {
                options.after(data.method);
                target.postMessage({ id: data.id, type: "result", value } satisfies Message);
              }
            },
          })
        )
      );
      if (Result.isFailure(outcome)) {
        const cause = outcome.failure;
        options.onError(cause, data.method, data.args);
        target.postMessage({
          id: data.id,
          message: cause instanceof Error ? cause.message : "Worker operation failed",
          type: "error",
          ...(cause instanceof HTTPError && typeof cause.status === "number"
            ? { code: cause.code ?? cause.type, status: cause.status }
            : {}),
        } satisfies Message);
      }
    };
    void run();
  };
  target.postMessage({ type: "ready" } satisfies Message);
  return {
    async drain() {
      await Promise.allSettled([...operations]);
    },
    emit<K extends keyof Events & string>(event: K, value: Events[K]) {
      target.postMessage({ event, type: "event", value } satisfies Message);
    },
  };
}
