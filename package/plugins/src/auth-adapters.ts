import type { PluginAuth, PluginCredentials } from "./auth";

export interface ApiKeyAuth extends PluginAuth {
  connect: (apiKey: string) => Promise<void>;
}

export async function createApiKeyAuth(options: {
  credentials: PluginCredentials;
}): Promise<ApiKeyAuth> {
  let authenticated = Boolean(await options.credentials.get("api-key"));
  return {
    authorize() {
      return Promise.resolve({ url: null });
    },
    async connect(apiKey) {
      if (!apiKey.trim()) {
        throw new Error("API keys must not be empty");
      }
      await options.credentials.set("api-key", apiKey);
      authenticated = true;
    },
    credentials: options.credentials,
    async disconnect() {
      await options.credentials.delete("api-key");
      authenticated = false;
    },
    status() {
      return { account: null, authenticated, error: null, pending: false };
    },
  };
}

/** Custom providers keep their existing semantics behind the same host-owned contract. */
export function createCustomAuth(adapter: PluginAuth): PluginAuth {
  return {
    authorize() {
      return adapter.authorize();
    },
    credentials: adapter.credentials,
    disconnect() {
      return adapter.disconnect();
    },
    status() {
      const { authenticated, pending, account, error } = adapter.status();
      return { account, authenticated, error, pending };
    },
  };
}
