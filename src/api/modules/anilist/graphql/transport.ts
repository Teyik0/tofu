import type { DocumentNode } from "graphql";
import { ClientError, GraphQLClient, type Variables } from "graphql-request";
import { getSdk } from "./generated";

/**
 * AniList could not answer. The generated SDK requires its requester to throw; the AniList
 * service returns this as a typed 502 problem. The message never contains request data.
 */
export class AniListUnavailable extends Error {}

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
      try {
        return await client.request<Result>({
          document,
          requestHeaders: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
          signal: options?.signal,
          // The SDK supplies generated operation variables; this adapts its generic
          // requester to graphql-request's transport-only Variables constraint.
          variables: variables as Variables | undefined,
        });
      } catch (cause) {
        if (
          options?.signal.aborted &&
          !(
            options.signal.reason instanceof DOMException &&
            options.signal.reason.name === "TimeoutError"
          )
        ) {
          throw cause;
        }
        if (cause instanceof ClientError) {
          const message =
            cause.response.status >= 400
              ? `AniList unavailable (HTTP ${cause.response.status})`
              : "AniList: account or list inaccessible";
          // Do not expose upstream query variables or credentials in API errors.
          // biome-ignore lint/style/useErrorCause: ClientError contains sensitive upstream request and response data.
          throw new AniListUnavailable(message);
        }
        // biome-ignore lint/style/useErrorCause: Transport errors may contain upstream request details or credentials.
        throw new AniListUnavailable("AniList unavailable");
      }
    }
  );
}
