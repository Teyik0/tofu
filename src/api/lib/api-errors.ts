import { Elysia, NotFound, ParseError, ValidationError } from "elysia";
import { UserError } from "./errors";

// Handle API error classes explicitly so Furin retains its page error responses.
export const apiErrorsPlugin = new Elysia({ name: "tofu-api-errors" }).error(
  "global",
  ({ error, status }) => {
    const body = { error: error instanceof Error ? error.message : "Unexpected error" };
    if (error instanceof ValidationError) {
      return status(422, body);
    }
    if (error instanceof NotFound) {
      return status(404, body);
    }
    if (error instanceof ParseError) {
      return status(400, body);
    }
    if (error instanceof UserError) {
      switch (error.status) {
        case 400:
          return status(400, body);
        case 404:
          return status(404, body);
        case 408:
          return status(408, body);
        case 409:
          return status(409, body);
        case 429:
          return status(429, body);
        case 502:
          return status(502, body);
        case 503:
          return status(503, body);
        default:
          return status(500, body);
      }
    }
  }
);
