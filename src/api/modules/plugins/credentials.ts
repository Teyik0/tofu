import { Effect, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { problem } from "elysia";
import { parseRss } from "./feeds";
import type { CredentialPluginId } from "./model";

const urlCredential = /^[a-z][a-z\d+.-]*:/i;

/** The API key in `input`, or a returned 400 when a C411 link cannot carry one. */
export function normalizePluginCredential(id: CredentialPluginId, input: string) {
  const value = input.trim();
  if (id !== "c411" || !urlCredential.test(value)) {
    return value;
  }
  const url = URL.parse(value);
  const keys = url?.searchParams.getAll("apikey");
  if (
    url?.origin !== "https://c411.org" ||
    url.username ||
    url.password ||
    url.hash ||
    !["/api/torznab", "/api/torznab/"].includes(url.pathname) ||
    keys?.length !== 1 ||
    !keys[0]?.trim()
  ) {
    return problem(400, {
      detail: "Paste your C411 API key or a Torznab link from C411 API integrations",
    });
  }
  return keys[0].trim();
}

export const validatePluginCredential = Effect.fn("Plugins.validateCredentialResponse")(
  function* (options: { id: CredentialPluginId; apiKey: string; endpoint: string }) {
    const { apiKey, endpoint } = options;
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const url = new URL(endpoint);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("t", "search");
    url.searchParams.set("limit", "1");
    const name = "C411";
    const request = HttpClientRequest.get(url);
    const fetched = yield* Effect.result(
      http
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }))
    );
    if (Result.isFailure(fetched)) {
      return problem(502, {
        detail: `Unable to validate your ${name} API key. Check your connection and try again.`,
      });
    }
    const response = fetched.success;
    if ([401, 403].includes(response.status)) {
      return problem(400, {
        detail: `${name} rejected this API key. Generate a new key and try again.`,
      });
    }
    if (response.status === 429) {
      return problem(429, { detail: `${name} rate limit reached. Try again later.` });
    }
    if (response.status < 200 || response.status >= 300) {
      return problem(502, {
        detail: `Unable to validate your ${name} API key (HTTP ${response.status})`,
      });
    }
    const parsed = yield* Effect.result(
      response.text.pipe(
        Effect.flatMap((text) => parseRss(text, "c411")),
        Effect.asVoid
      )
    );
    if (parsed._tag === "Failure") {
      return problem(502, {
        detail: `Unable to validate your ${name} API key. Check your connection and try again.`,
      });
    }
    return null;
  },
  Effect.scoped
);
