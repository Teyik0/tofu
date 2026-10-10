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
    const result = (await response.json().catch(() => ({ error: `Error ${response.status}` }))) as {
      error?: string;
    };
    throw new Error(result.error ?? `Error ${response.status}`);
  }
  return (await response.json()) as T;
}
