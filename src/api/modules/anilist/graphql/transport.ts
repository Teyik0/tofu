import type { DocumentNode } from "graphql";
import { ClientError, GraphQLClient, type Variables } from "graphql-request";
import { UserError } from "../../../lib/errors";
import { getSdk } from "./generated";

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
          throw new UserError(message, { status: 502 });
        }
        // biome-ignore lint/style/useErrorCause: Transport errors may contain upstream request details or credentials.
        throw new UserError("AniList unavailable", { status: 502 });
      }
    }
  );
}
