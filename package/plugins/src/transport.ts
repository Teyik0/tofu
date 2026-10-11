import "@teyik0/furin/server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { Elysia } from "elysia";

type RequestHandler = (request: Request) => Response | Promise<Response>;
// Furin's development loaders reload this module independently of the root server.
const processTransport = globalThis as typeof globalThis & {
  tofuApiRequestHandlers?: AsyncLocalStorage<RequestHandler>;
};
processTransport.tofuApiRequestHandlers ??= new AsyncLocalStorage<RequestHandler>();
const requestHandlers = processTransport.tofuApiRequestHandlers;

// SSR API calls reuse the mounted router; AOT allows one router per process.
export const apiTransportPlugin = new Elysia({ name: "tofu-api-transport" }).wrap(
  (next) =>
    (request, ...rest: unknown[]) =>
      requestHandlers.run(
        (nested) => next(nested),
        () => next(request, ...rest)
      )
);

export const serverApiFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const handle = requestHandlers.getStore();
    if (!handle) {
      throw new Error("Server API calls require an active request");
    }
    return Promise.resolve(handle(new Request(input, init)));
  },
  { preconnect: fetch.preconnect }
);
