import { expect } from "bun:test";
export function expectDefined<T>(value: T): asserts value is NonNullable<T> {
  expect(value).not.toBeUndefined();
  expect(value).not.toBeNull();
}
export function expectProblem(
  result: { status: number; response: Response; error: { value: unknown } | null },
  status: number,
  detail: string
) {
  expect(result.status).toBe(status);
  expect(result.response.headers.get("content-type")).toBe("application/problem+json");
  expectDefined(result.error);
  expect(result.error.value).toMatchObject({
    detail,
    status,
    title: expect.any(String),
    type: expect.any(String),
  });
  expect(result.error.value).not.toHaveProperty("error");
}
export function expectSuccess<T>(result: { data: T | null; error: unknown; status: number }) {
  expect(result.status).toBe(200);
  expect(result.error).toBeNull();
  expectDefined(result.data);
  return result.data;
}
