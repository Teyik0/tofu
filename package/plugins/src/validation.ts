import { number, pipe, regex, string, toNumber, union } from "valibot";

// Preserve Elysia's decimal input coercion without accepting whitespace or hex notation.
export const integerInput = union([number(), pipe(string(), regex(/^[+-]?\d+$/), toNumber())]);

export const numericInput = union([
  number(),
  pipe(string(), regex(/^[+-]?\d+(?:\.\d+)?$/), toNumber()),
]);
