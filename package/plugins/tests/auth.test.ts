import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKeyAuth,
  createCredentialStore,
  createCustomAuth,
  createOAuth2Auth,
  createPluginScope,
} from "../src/server";

test("API key authentication persists privately and exposes only safe status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-auth-"));
  try {
    const options = { directory, pluginId: "key-plugin" };
    const credentials = await createCredentialStore(options);
    const auth = await createApiKeyAuth({ credentials });
    await auth.connect("private-api-key");
    expect(auth.status()).toEqual({
      account: null,
      authenticated: true,
      error: null,
      pending: false,
    });
    expect(JSON.stringify(auth.status())).not.toContain("private-api-key");
    const restoredCredentials = await createCredentialStore(options);
    expect(await restoredCredentials.get("api-key")).toBe("private-api-key");
    // biome-ignore lint/suspicious/noBitwiseOperators: Mask file permission bits to verify private credential storage.
    expect((await stat(join(directory, "key-plugin", "credentials.json"))).mode & 0o777).toBe(
      0o600
    );
    const restoredAuth = await createApiKeyAuth({ credentials: restoredCredentials });
    expect(restoredAuth.status().authenticated).toBe(true);
    await restoredAuth.disconnect();
    expect(restoredAuth.status().authenticated).toBe(false);
    expect(await restoredCredentials.get("api-key")).toBeNull();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("custom auth adapters project public status without exposing provider-specific secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-custom-auth-"));
  try {
    const credentials = await createCredentialStore({ directory, pluginId: "custom-plugin" });
    const auth = createCustomAuth({
      authorize() {
        return Promise.resolve({ url: null });
      },
      credentials,
      disconnect() {
        return Promise.resolve();
      },
      status() {
        return {
          account: "Account",
          authenticated: true,
          error: null,
          pending: false,
          token: "private-token",
        };
      },
    });
    expect(auth.status()).toEqual({
      account: "Account",
      authenticated: true,
      error: null,
      pending: false,
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("disposing OAuth work during token exchange prevents credentials from being stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-oauth-cancel-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = Bun.serve({
    async fetch() {
      started.resolve();
      await release.promise;
      return Response.json({ access_token: "cancelled-token", token_type: "Bearer" });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const scope = createPluginScope();
    const credentials = await createCredentialStore({ directory, pluginId: "cancel-plugin" });
    const auth = await createOAuth2Auth({
      authorizationUrl: `${provider.url}authorize`,
      clientAuthentication: "none",
      clientId: "public-client-id",
      credentials,
      pkce: true,
      redirectUri: "http://localhost/callback",
      scope,
      scopes: [],
      tokenUrl: `${provider.url}token`,
    });
    const { url } = await auth.authorize();
    const callback = new URL("http://localhost/callback?code=code");
    callback.searchParams.set("state", new URL(url ?? "").searchParams.get("state") ?? "");
    const completion = auth.callback(callback);
    await started.promise;
    await scope.dispose();
    release.resolve();
    await expect(completion).rejects.toThrow("OAuth authorization failed");
    expect(await credentials.get("access-token")).toBeNull();
    expect(auth.status().pending).toBe(false);
  } finally {
    release.resolve();
    await provider.stop(true);
    await rm(directory, { recursive: true });
  }
});

test("OAuth code callbacks validate one-time state and PKCE before storing tokens privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-oauth-"));
  let authorization: URL | null = null;
  let requests = 0;
  const provider = Bun.serve({
    async fetch(request) {
      requests += 1;
      const form = new URLSearchParams(await request.text());
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("authorization-code");
      expect(form.get("client_secret")).toBe("private-client-secret");
      const verifier = form.get("code_verifier");
      expect(verifier).not.toBeNull();
      const challenge = new Bun.CryptoHasher("sha256").update(verifier ?? "").digest("base64url");
      expect(challenge).toBe(authorization?.searchParams.get("code_challenge") ?? "");
      return Response.json({
        access_token: "private-access-token",
        refresh_token: "private-refresh-token",
        token_type: "Bearer",
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const credentials = await createCredentialStore({ directory, pluginId: "oauth-plugin" });
    const auth = await createOAuth2Auth({
      authorizationUrl: `${provider.url}authorize`,
      clientAuthentication: "body",
      clientId: "public-client-id",
      clientSecret: "private-client-secret",
      credentials,
      pkce: true,
      redirectUri: "http://localhost/callback",
      scopes: ["read"],
      tokenUrl: `${provider.url}token`,
    });
    const result = await auth.authorize();
    authorization = new URL(result.url ?? "");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("client_secret")).toBeNull();
    await expect(
      auth.callback("http://localhost/callback?code=authorization-code&state=wrong-state")
    ).rejects.toThrow("state");
    expect(requests).toBe(0);
    const callback = new URL("http://localhost/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    const status = await auth.callback(callback);
    expect(status.authenticated).toBe(true);
    expect(status.pending).toBe(false);
    expect(JSON.stringify(status)).not.toContain("private-");
    expect(await credentials.get("access-token")).toBe("private-access-token");
    await expect(auth.callback(callback)).rejects.toThrow("state");
    expect(requests).toBe(1);
    await auth.disconnect();
    expect(await credentials.get("access-token")).toBeNull();
    expect(await credentials.get("refresh-token")).toBeNull();
  } finally {
    await provider.stop(true);
    await rm(directory, { recursive: true });
  }
});

test("disposing OAuth during credential persistence drains writes and restores the previous account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-oauth-storage-cancel-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = Bun.serve({
    fetch() {
      return Response.json({
        access_token: "cancelled-new-token",
        expires_in: 3600,
        refresh_token: "cancelled-refresh",
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const options = { directory, pluginId: "cancel-storage" };
    const stored = await createCredentialStore(options);
    await stored.set("access-token", "previous-token");
    await stored.set("token-type", "Bearer");
    const credentials = {
      ...stored,
      async set(name: string, value: string) {
        await stored.set(name, value);
        if (name === "access-token" && value === "cancelled-new-token") {
          started.resolve();
          await release.promise;
        }
      },
    };
    const scope = createPluginScope();
    const auth = await createOAuth2Auth({
      authorizationUrl: `${provider.url}authorize`,
      clientAuthentication: "none",
      clientId: "public-client",
      credentials,
      pkce: true,
      redirectUri: "http://localhost/callback",
      scope,
      scopes: [],
      tokenUrl: `${provider.url}token`,
    });
    const { url } = await auth.authorize();
    const callback = new URL("http://localhost/callback?code=valid-code");
    callback.searchParams.set("state", new URL(url ?? "").searchParams.get("state") ?? "");
    const completion = auth.callback(callback);
    await started.promise;
    const disposal = scope.dispose();
    release.resolve();
    await disposal;
    await expect(completion).rejects.toThrow("OAuth authorization failed");
    const restored = await createCredentialStore(options);
    expect(await restored.get("access-token")).toBe("previous-token");
    expect(await restored.get("refresh-token")).toBeNull();
    expect(await restored.get("token-type")).toBe("Bearer");
    expect(await restored.get("expires-at")).toBeNull();
  } finally {
    release.resolve();
    provider.stop(true);
    await rm(directory, { recursive: true });
  }
});
