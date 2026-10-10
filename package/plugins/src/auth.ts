export type PluginAuthDefinition =
  | {
      kind: "oauth2";
      clientId: string;
      clientAuthentication?: "none" | "body" | "basic";
      clientSecret?: string;
      redirectUri?: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: readonly string[];
      pkce: boolean;
    }
  | { kind: "api-key"; label: string; helpUrl?: string }
  | { kind: "custom"; label: string };

/** Public status is safe to serialize; credentials are never part of this value. */
export interface PluginAuthStatus {
  account: string | null;
  authenticated: boolean;
  error: string | null;
  pending: boolean;
}

/** Backend-only host adapter. Plugins must not return credential values in their API. */
export interface PluginCredentials {
  delete: (name: string) => Promise<void>;
  get: (name: string) => Promise<string | null>;
  set: (name: string, value: string) => Promise<void>;
}

export interface PluginAuth {
  authorize: () => Promise<{ url: string | null }>;
  readonly credentials: PluginCredentials;
  disconnect: () => Promise<void>;
  status: () => PluginAuthStatus;
}
