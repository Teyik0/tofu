import { Effect, Result } from "effect";
import { problem } from "elysia";
import { parseJevResponse } from "../jev/service";
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

export async function validatePluginCredential(options: {
  id: CredentialPluginId;
  apiKey: string;
  endpoint: string;
  signal: AbortSignal;
}) {
  const { id, apiKey, endpoint, signal } = options;
  const questions = {
    connected: { instructions: "Does the message say connection test?", type: "noul" as const },
  };
  const url = new URL(endpoint);
  if (id === "c411") {
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("t", "search");
    url.searchParams.set("limit", "1");
  }
  const name = id === "c411" ? "C411" : "TypeSafe";
  const fetched = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          fetch(url, {
            ...(id === "jev"
              ? {
                  body: JSON.stringify({
                    model: "jev-latest",
                    questions,
                    state: { message: "connection test" },
                  }),
                  headers: {
                    authorization: `Bearer ${apiKey}`,
                    "content-type": "application/json",
                  },
                  method: "POST",
                }
              : {}),
            redirect: "error",
            signal,
          }),
      })
    )
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
  if (!response.ok) {
    return problem(502, {
      detail: `Unable to validate your ${name} API key (HTTP ${response.status})`,
    });
  }
  const decoded = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => (id === "c411" ? response.text() : response.json()),
      })
    )
  );
  if (Result.isFailure(decoded)) {
    return problem(502, {
      detail: `Unable to validate your ${name} API key. Check your connection and try again.`,
    });
  }
  const parsed = Effect.runSync(
    Effect.result(
      Effect.try({
        catch: (cause) => cause,
        try: () =>
          id === "c411"
            ? parseRss(decoded.success as string, "c411")
            : parseJevResponse(decoded.success, questions),
      })
    )
  );
  if (Result.isFailure(parsed)) {
    return problem(502, {
      detail: `Unable to validate your ${name} API key. Check your connection and try again.`,
    });
  }
  return null;
}
