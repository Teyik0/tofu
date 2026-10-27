import { hostDesktopTarget, installerName } from "../../../../.github/scripts/platform";

export function updatesProvider() {
  const name = installerName("99.0.0", hostDesktopTarget());
  const bytes = new Uint8Array([84, 111, 102, 117]);
  const state: {
    assetHeaders: Headers | null;
    cancelled: boolean;
    invalidRedirect: boolean;
    missing: boolean;
    release: unknown;
    signedRedirect: boolean;
    streaming: boolean;
  } = {
    assetHeaders: null,
    cancelled: false,
    invalidRedirect: false,
    missing: false,
    release: {
      assets: [{ id: 1, name }],
      draft: false,
      prerelease: false,
      tag_name: "v99.0.0",
    },
    signedRedirect: false,
    streaming: false,
  };
  const server = Bun.serve({
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/github/repos/Teyik0/Tofu/releases/latest") {
        return state.missing ? new Response(null, { status: 404 }) : Response.json(state.release);
      }
      if (path === "/github/repos/Teyik0/Tofu/releases/assets/1") {
        if (state.streaming) {
          state.cancelled = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                state.cancelled = true;
              },
              start(controller) {
                controller.enqueue(bytes);
              },
            })
          );
        }
        if (state.signedRedirect && !state.invalidRedirect) {
          return Response.redirect(
            "https://release-assets.githubusercontent.com/tofu-installer",
            302
          );
        }
        return state.invalidRedirect
          ? Response.redirect("https://untrusted.example/installer", 302)
          : new Response(bytes);
      }
      if (path === "/github-assets/tofu-installer") {
        state.assetHeaders = request.headers;
        return new Response(bytes);
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
