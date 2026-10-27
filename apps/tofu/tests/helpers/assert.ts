import { expect } from "bun:test";

export function success<T>(result: { data: T | null; error: unknown; status: number }): T {
  expect(result.error, JSON.stringify(result.error)).toBeNull();
  expect(result.status).toBe(200);
  if (result.data === null) {
    throw new Error("The endpoint returned no data");
  }
  return result.data;
}

export function expectBytes(
  result: { data: unknown; error: unknown; status: number },
  expected: Uint8Array
) {
  const data = success(result);
  if (!(data instanceof ArrayBuffer)) {
    throw new Error("Expected a binary file response");
  }
  expect(new Uint8Array(data)).toEqual(new Uint8Array(expected));
}

export function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) {
    throw new Error("The server did not issue a session cookie");
  }
  return header.split(";")[0] ?? "";
}
