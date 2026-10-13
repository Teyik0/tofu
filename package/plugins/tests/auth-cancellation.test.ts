import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore, createOAuth2Auth, createPluginScope } from "../src/server";

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
