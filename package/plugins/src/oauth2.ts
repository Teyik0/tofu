import { Type } from "typebox";
import { Check } from "typebox/value";
import type { PluginAuth, PluginAuthStatus, PluginCredentials } from "./auth";
import type { PluginScope } from "./lifecycle";

export interface OAuth2Auth extends PluginAuth {
  callback: (url: string | URL) => Promise<PluginAuthStatus>;
}

export interface OAuth2Options {
  authorizationUrl: string;
  clientAuthentication: "none" | "body" | "basic";
  clientId: string;
  clientSecret?: string;
  credentials: PluginCredentials;
  pkce: boolean;
  redirectUri: string;
  scope?: PluginScope;
  scopes: readonly string[];
  tokenUrl: string;
}

const tokenSchema = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  expires_in: Type.Optional(Type.Number({ minimum: 0 })),
  refresh_token: Type.Optional(Type.String()),
  token_type: Type.Optional(Type.String()),
});

function requireSecureEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OAuth endpoints must use HTTPS or a local loopback URL");
  }
  return url;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function exchangeTokens(options: OAuth2Options, code: string, verifier: string | null) {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  });
  if (verifier) {
    body.set("code_verifier", verifier);
  }
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (options.clientAuthentication === "basic") {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret ?? "")}`).toString("base64")}`
    );
    body.delete("client_id");
  } else if (options.clientAuthentication === "body") {
    body.set("client_secret", options.clientSecret ?? "");
  }
  const response = await fetch(options.tokenUrl, {
    body,
    headers,
    method: "POST",
    redirect: "error",
    signal: options.scope?.signal,
  });
  if (!response.ok) {
    throw new Error("The authorization provider rejected the token exchange");
  }
  const tokens: unknown = await response.json();
  if (!Check(tokenSchema, tokens)) {
    throw new Error("The authorization provider returned an invalid token response");
  }
  return tokens;
}

/** Host-managed authorization-code flow; tokens and the PKCE verifier remain backend-only. */
export async function createOAuth2Auth(options: OAuth2Options): Promise<OAuth2Auth> {
  const authorizationEndpoint = requireSecureEndpoint(options.authorizationUrl);
  requireSecureEndpoint(options.tokenUrl);
  const redirect = new URL(options.redirectUri);
  if (options.clientAuthentication !== "none" && !options.clientSecret) {
    throw new Error("The selected OAuth client authentication requires a client secret");
  }
  let authenticated = Boolean(await options.credentials.get("access-token"));
  const storedExpiry = await options.credentials.get("expires-at");
  let expiresAt =
    storedExpiry && Number.isFinite(Number(storedExpiry)) ? Number(storedExpiry) : null;
  let pending: { state: string; verifier: string | null; expiresAt: number } | null = null;
  let completing = false;
  let error: string | null = null;
  let generation = 0;
  let storage = Promise.resolve();
  options.scope?.onDispose(async () => {
    generation += 1;
    pending = null;
    await storage;
  });
  const enqueue = (operation: () => Promise<void>) => {
    const result = storage.then(operation);
    storage = result.catch(() => undefined);
    return result;
  };
  const status = (): PluginAuthStatus => ({
    account: null,
    authenticated: authenticated && (expiresAt === null || expiresAt > Date.now()),
    error,
    pending: completing || Boolean(pending && pending.expiresAt > Date.now()),
  });
  return {
    authorize() {
      return Promise.resolve().then(() => {
        options.scope?.signal.throwIfAborted();
        if (completing) {
          throw new Error("Authorization is already being completed");
        }
        generation += 1;
        const state = randomToken();
        const verifier = options.pkce ? randomToken() : null;
        pending = { expiresAt: Date.now() + 10 * 60 * 1000, state, verifier };
        error = null;
        const url = new URL(authorizationEndpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", options.clientId);
        url.searchParams.set("redirect_uri", options.redirectUri);
        url.searchParams.set("state", state);
        if (options.scopes.length > 0) {
          url.searchParams.set("scope", options.scopes.join(" "));
        }
        if (verifier) {
          url.searchParams.set(
            "code_challenge",
            new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
          );
          url.searchParams.set("code_challenge_method", "S256");
        }
        return { url: url.href };
      });
    },
    async callback(input) {
      options.scope?.signal.throwIfAborted();
      const url = new URL(input);
      if (
        url.protocol !== redirect.protocol ||
        url.host !== redirect.host ||
        url.pathname !== redirect.pathname
      ) {
        throw new Error("The OAuth callback does not match the configured redirect URI");
      }
      const attempt = pending;
      if (
        !attempt ||
        attempt.expiresAt <= Date.now() ||
        url.searchParams.get("state") !== attempt.state
      ) {
        throw new Error("The OAuth callback state is invalid or expired");
      }
      pending = null;
      const currentGeneration = generation;
      if (url.searchParams.has("error")) {
        error = "The authorization provider declined the request";
        throw new Error(error);
      }
      const code = url.searchParams.get("code");
      if (!code) {
        error = "The OAuth callback did not contain an authorization code";
        throw new Error(error);
      }
      completing = true;
      try {
        const tokens = await exchangeTokens(options, code, attempt.verifier);
        await enqueue(async () => {
          const assertActive = () => {
            if (generation !== currentGeneration || options.scope?.signal.aborted) {
              throw new Error("Authorization was cancelled");
            }
          };
          assertActive();
          const names = ["access-token", "token-type", "refresh-token", "expires-at"] as const;
          const previous = await Promise.all(
            names.map(async (name) => ({
              name,
              value: await options.credentials.get(name),
            }))
          );
          assertActive();
          const nextExpiry =
            tokens.expires_in === undefined ? null : Date.now() + tokens.expires_in * 1000;
          try {
            await options.credentials.set("access-token", tokens.access_token);
            assertActive();
            await options.credentials.set("token-type", tokens.token_type ?? "Bearer");
            assertActive();
            if (tokens.refresh_token) {
              await options.credentials.set("refresh-token", tokens.refresh_token);
            } else {
              await options.credentials.delete("refresh-token");
            }
            assertActive();
            if (nextExpiry === null) {
              await options.credentials.delete("expires-at");
            } else {
              await options.credentials.set("expires-at", String(nextExpiry));
            }
            assertActive();
          } catch (cause) {
            const restored = await Promise.allSettled(
              previous.map(({ name, value }) =>
                value === null
                  ? options.credentials.delete(name)
                  : options.credentials.set(name, value)
              )
            );
            const failures = restored.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : []
            );
            if (failures.length) {
              // biome-ignore lint/style/useErrorCause: AggregateError receives its cause in the third argument below.
              throw new AggregateError(
                failures,
                "Unable to restore credentials after cancelled authorization",
                { cause }
              );
            }
            throw cause;
          }
          expiresAt = nextExpiry;
          authenticated = true;
        });
      } catch {
        // Provider responses and network exceptions may contain secrets.
        error = "OAuth authorization failed";
        // biome-ignore lint/style/useErrorCause: Provider exceptions may contain tokens and must not enter host logs.
        throw new Error(error);
      } finally {
        completing = false;
      }
      return status();
    },
    credentials: options.credentials,
    async disconnect() {
      generation += 1;
      pending = null;
      await enqueue(async () => {
        await Promise.all(
          ["access-token", "refresh-token", "token-type", "expires-at"].map((name) =>
            options.credentials.delete(name)
          )
        );
        authenticated = false;
        expiresAt = null;
        error = null;
      });
    },
    status,
  };
}
