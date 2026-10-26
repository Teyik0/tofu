import { Schema } from "effect";
import type { DocumentNode } from "graphql";
import { ClientError, GraphQLClient, type Variables } from "graphql-request";
import { getSdk } from "./generated";

/**
 * Expected provider failures never retain upstream request data or credentials.
 */
export class AniListUnavailable extends Schema.TaggedError<AniListUnavailable>()(
  "AniListUnavailable",
  {
    message: Schema.String,
    retryAfter: Schema.optional(Schema.Number),
  }
) {}

export class AniListCancelled extends Schema.TaggedError<AniListCancelled>()(
  "AniListCancelled",
  {}
) {}

export function anilistRequestError(cause: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return new AniListCancelled({});
  }
  if (cause instanceof ClientError) {
    const retryAfter = cause.response.headers.get("retry-after");
    const seconds = retryAfter ? Number(retryAfter) : 0;
    return new AniListUnavailable({
      message:
        cause.response.status >= 400
          ? `AniList unavailable (HTTP ${cause.response.status})`
          : "AniList: account or list inaccessible",
      retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
    });
  }
  return new AniListUnavailable({ message: "AniList unavailable" });
}

interface RequestOptions {
  accessToken?: string;
  signal: AbortSignal;
}

export function createAniListSdk(endpoint: string, token: () => string) {
  const client = new GraphQLClient(endpoint, { errorPolicy: "none" });
  return getSdk<RequestOptions>(
    async <Result, Input>(
      document: DocumentNode,
      variables?: Input,
      options?: RequestOptions
    ): Promise<Result> => {
      const accessToken = options?.accessToken ?? token();
      return await client.request<Result>({
        document,
        requestHeaders: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
        signal: options?.signal,
        // Adapt generated operation variables to the transport's generic constraint.
        variables: variables as Variables | undefined,
      });
    }
  );
}
