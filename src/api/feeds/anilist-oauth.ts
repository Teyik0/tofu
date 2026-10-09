import { UserError } from "../engine";

interface AuthorizationAttempt {
  processing: boolean;
  redirect: URL;
  state: string;
}

function callbackPage() {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect AniList · Tofu</title></head>
<body><main><h1>Connecting AniList</h1><p role="status" id="status">Finishing your connection to Tofu…</p></main>
<script nonce="${nonce}">
(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const payload = {
    access_token: fragment.get("access_token"),
    state: fragment.get("state") || query.get("state"),
    error: fragment.get("error") || query.get("error")
  };
  history.replaceState(null, "", location.pathname);
  const status = document.getElementById("status");
  try {
    if (!payload.state || !(payload.access_token || payload.error)) {
      throw new Error("Invalid or expired connection. Restart the connection from Tofu.");
    }
    const response = await fetch(location.pathname, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    status.textContent = "AniList connected successfully. You can close this tab and return to Tofu.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to connect AniList. Return to Tofu and try again.";
  }
})();
</script></body></html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

/** Receives AniList's implicit grant in the native app or a legacy loopback callback. */
export class AniListAuthorization {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private attempt: AuthorizationAttempt | null = null;
  private readonly complete: (token: string, current: () => boolean) => Promise<void>;
  error: string | null = null;

  constructor(complete: (token: string, current: () => boolean) => Promise<void>) {
    this.complete = complete;
  }

  get pending() {
    return this.attempt !== null;
  }

  connect(clientId: string, redirectUri: string) {
    this.close();
    this.error = null;
    const redirect = new URL(redirectUri);
    const attempt = { processing: false, redirect, state: crypto.randomUUID() };
    this.attempt = attempt;
    try {
      if (redirect.protocol === "http:") {
        this.server = Bun.serve({
          fetch: (request) => this.callback(request, redirect, attempt),
          hostname: "127.0.0.1",
          maxRequestBodySize: 16_384,
          port: Number(redirect.port),
        });
      }
    } catch (cause) {
      this.attempt = null;
      throw new UserError(
        `AniList connection needs local port ${redirect.port}. Close the app using that port and try again.`,
        { cause, status: 409 }
      );
    }
    this.timeout = setTimeout(() => {
      if (this.pending) {
        this.error = "AniList authorization expired. Connect again to continue.";
      }
      this.close();
    }, 600_000);
    this.timeout.unref();
    const url = new URL("https://anilist.co/api/v2/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    // AniList's implicit grant uses the callback registered in its developer settings.
    url.searchParams.set("response_type", "token");
    url.searchParams.set("state", attempt.state);
    return { url: url.href };
  }

  async receiveUrl(input: string) {
    const { attempt } = this;
    const url = URL.parse(input);
    if (
      !(url && attempt && ["tofu:", "tofu-dev:"].includes(url.protocol)) ||
      url.protocol !== attempt.redirect.protocol ||
      url.hostname !== "oauth" ||
      url.pathname !== "/anilist" ||
      url.username ||
      url.password ||
      url.port ||
      url.search
    ) {
      throw new UserError("Invalid or expired OAuth callback. Restart the connection from Tofu.", {
        status: 400,
      });
    }
    const fragment = new URLSearchParams(url.hash.slice(1));
    const response = await this.accept(
      {
        access_token: fragment.get("access_token"),
        error: fragment.get("error"),
        state: fragment.get("state"),
      },
      attempt
    );
    if (!response.ok) {
      const result = (await response.json()) as { error: string };
      throw new UserError(result.error, { status: response.status });
    }
  }

  private async callback(request: Request, redirect: URL, attempt: AuthorizationAttempt) {
    const url = new URL(request.url);
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
    const reject = (error: string, status: number) => Response.json({ error }, { headers, status });
    if (url.pathname !== redirect.pathname || url.origin !== redirect.origin) {
      return reject("Unknown callback", 404);
    }
    if (request.method === "GET") {
      return callbackPage();
    }
    if (request.method !== "POST") {
      return reject("Method not allowed", 405);
    }
    if (
      request.headers.get("origin") !== redirect.origin ||
      request.headers.get("content-type") !== "application/json"
    ) {
      return reject("Invalid callback origin", 403);
    }
    const body: unknown = await request.json().catch(() => null);
    return this.accept(body, attempt);
  }

  private async accept(body: unknown, attempt: AuthorizationAttempt) {
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
    const reject = (error: string, status: number) => Response.json({ error }, { headers, status });
    if (
      !body ||
      typeof body !== "object" ||
      !("state" in body) ||
      body.state !== attempt.state ||
      this.attempt !== attempt ||
      attempt.processing
    ) {
      return reject("Invalid or expired OAuth callback. Restart the connection from Tofu.", 400);
    }
    if ("error" in body && body.error) {
      this.attempt = null;
      this.error = "AniList authorization was declined. Connect again when you are ready.";
      return reject(this.error, 400);
    }
    if (
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > 4096
    ) {
      return reject("Missing AniList access token", 400);
    }
    attempt.processing = true;
    try {
      await this.complete(body.access_token, () => this.attempt === attempt);
      return Response.json({ connected: true }, { headers });
    } catch {
      if (this.attempt === attempt) {
        this.error =
          "Unable to connect or load your AniList account. Return to Tofu and try again.";
      }
      return reject(
        "Unable to connect or load your AniList account. Return to Tofu and try again.",
        502
      );
    } finally {
      if (this.attempt === attempt) {
        this.attempt = null;
      }
    }
  }

  close() {
    this.attempt = null;
    this.server?.stop(true);
    this.server = null;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}
