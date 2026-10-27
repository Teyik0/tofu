import { EdenFetchError } from "@elysia/eden";

export async function request<T>(
  path: string,
  method: string,
  body: object | FormData | undefined,
  signal?: AbortSignal
) {
  const response = await fetch(`/api${path}`, {
    body: body instanceof FormData ? body : JSON.stringify(body),
    headers:
      body && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    method,
    signal,
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => ({
      detail: `API request failed (${response.status})`,
    }));
    throw new EdenFetchError(response.status, value);
  }
  return (await response.json()) as T;
}
