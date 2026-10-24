import { Effect, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";

interface AuthorizationAttempt {
  deviceId?: string;
  processing: boolean;
  redirect: URL;
  state: string;
}

function callbackProblem(detail: string, status: number) {
  const failure = problem(status, { detail });
  return Response.json(failure.response, {
    headers: {
      ...failure.headers,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
    status: failure.status,
  });
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
  if (!payload.state || !(payload.access_token || payload.error)) {
    status.textContent = "Invalid or expired connection. Restart the connection from Tofu.";
    return;
  }
  const [request] = await Promise.allSettled([fetch(location.pathname, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  })]);
  if (request.status === "rejected") {
    status.textContent = "Unable to connect AniList. Return to Tofu and try again.";
    return;
  }
  const response = request.value;
  const [decoded] = await Promise.allSettled([response.json()]);
  status.textContent = decoded.status === "rejected"
    ? "Unable to connect AniList. Return to Tofu and try again."
    : response.ok
      ? "AniList connected successfully. You can close this tab and return to Tofu."
      : decoded.value?.detail ?? decoded.value?.title ?? "Unable to connect AniList";
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
  /** Stores the token and loads the account; a returned problem means the connection failed. */
  private readonly complete: (token: string, current: () => boolean) => Promise<unknown>;
  error: string | null = null;

  constructor(complete: (token: string, current: () => boolean) => Promise<unknown>) {
    this.complete = complete;
  }

  get pending() {
    return this.attempt !== null;
  }

  connect(clientId: string, redirectUri: string, deviceId?: string) {
    this.close();
    this.error = null;
    const redirect = new URL(redirectUri);
    const attempt = { deviceId, processing: false, redirect, state: crypto.randomUUID() };
    this.attempt = attempt;
    if (redirect.protocol === "http:") {
      const server = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () =>
              Bun.serve({
                fetch: (request) => this.callback(request, redirect, attempt),
                hostname: "127.0.0.1",
                maxRequestBodySize: 16_384,
                port: Number(redirect.port),
              }),
          })
        )
      );
      if (Result.isFailure(server)) {
        this.attempt = null;
        return problem(409, {
          detail: `AniList connection needs local port ${redirect.port}. Close the app using that port and try again.`,
        });
      }
      this.server = server.success;
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

  async receiveUrl(input: string, deviceId?: string) {
    const { attempt } = this;
    const url = URL.parse(input);
    if (
      !(url && attempt && ["tofu:", "tofu-dev:"].includes(url.protocol)) ||
      attempt.deviceId !== deviceId ||
      url.protocol !== attempt.redirect.protocol ||
      url.hostname !== "oauth" ||
      url.pathname !== "/anilist" ||
      url.username ||
      url.password ||
      url.port ||
      url.search
    ) {
      return problem(400, {
        detail: "Invalid or expired OAuth callback. Restart the connection from Tofu.",
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
      const result = (await response.json()) as { detail: string };
      return response.status === 400
        ? problem(400, { detail: result.detail })
        : problem(502, { detail: result.detail });
    }
  }

  private async callback(request: Request, redirect: URL, attempt: AuthorizationAttempt) {
    const url = new URL(request.url);
    if (url.pathname !== redirect.pathname || url.origin !== redirect.origin) {
      return callbackProblem("Unknown callback", 404);
    }
    if (request.method === "GET") {
      return callbackPage();
    }
    if (request.method !== "POST") {
      return callbackProblem("Method not allowed", 405);
    }
    if (
      request.headers.get("origin") !== redirect.origin ||
      request.headers.get("content-type") !== "application/json"
    ) {
      return callbackProblem("Invalid callback origin", 403);
    }
    const body = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => request.json(),
        })
      )
    );
    if (Result.isFailure(body)) {
      return callbackProblem("Invalid OAuth callback body", 400);
    }
    return this.accept(body.success, attempt);
  }

  private async accept(body: unknown, attempt: AuthorizationAttempt) {
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
    if (
      !body ||
      typeof body !== "object" ||
      !("state" in body) ||
      body.state !== attempt.state ||
      this.attempt !== attempt ||
      attempt.processing
    ) {
      return callbackProblem(
        "Invalid or expired OAuth callback. Restart the connection from Tofu.",
        400
      );
    }
    if ("error" in body && body.error) {
      this.attempt = null;
      this.error = "AniList authorization was declined. Connect again when you are ready.";
      return callbackProblem(this.error, 400);
    }
    if (
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > 4096
    ) {
      return callbackProblem("Missing AniList access token", 400);
    }
    attempt.processing = true;
    const failed = () => {
      if (this.attempt === attempt) {
        this.error =
          "Unable to connect or load your AniList account. Return to Tofu and try again.";
      }
      return callbackProblem(
        "Unable to connect or load your AniList account. Return to Tofu and try again.",
        502
      );
    };
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      if (this.attempt === attempt) {
        this.attempt = null;
      }
    });
    const completed = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => this.complete(body.access_token as string, () => this.attempt === attempt),
        })
      )
    );
    if (Result.isFailure(completed) || completed.success instanceof ElysiaStatus) {
      return failed();
    }
    return Response.json({ connected: true }, { headers });
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
