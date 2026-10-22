// Shared across the separately bundled native host and local backend in the same process.
// This registry contains capabilities, never credentials, and is absent in web/server processes.
const processState = globalThis as typeof globalThis & {
  tofuNativeHost?: typeof import("./host").nativeHost;
  tofuNativeThreads?: import("./remote-threads").RemoteThreads;
  tofuNativeServers?: {
    read: typeof import("./host").nativeServerSnapshot;
    run: typeof import("./host").runNativeServerAction;
  };
};

export { processState as nativeControl };
