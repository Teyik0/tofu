import { hostDesktopTarget, installerName } from "../../.github/scripts/platform";

export function updatesProvider() {
  const name = installerName("99.0.0", hostDesktopTarget());
  const bytes = new Uint8Array([84, 111, 102, 117]);
  const state: { invalidRedirect: boolean; missing: boolean } = {
    invalidRedirect: false,
    missing: false,
  };
  const server = Bun.serve({
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/github/repos/Teyik0/Tofu/releases/latest") {
        return state.missing
          ? new Response(null, { status: 404 })
          : Response.json({
              assets: [{ id: 1, name }],
              draft: false,
              prerelease: false,
              tag_name: "v99.0.0",
            });
      }
      if (path === "/github/repos/Teyik0/Tofu/releases/assets/1") {
        return state.invalidRedirect
          ? Response.redirect("https://untrusted.example/installer", 302)
          : new Response(bytes);
      }
      return new Response(null, { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    bytes,
    name,
    state,
    url: server.url.origin,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
    },
  };
}
