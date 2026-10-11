type ApiResult<Value> =
  | { data: Value; error: null }
  | { data: null; error: { status: unknown; value: unknown } };

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(failure: { status: unknown; value: unknown }) {
    const { value } = failure;
    let message = `API request failed (${failure.status})`;
    if (value instanceof Error) {
      ({ message } = value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
    ) {
      message = value.error;
    }
    super(message, { cause: value });
    this.status = typeof failure.status === "number" ? failure.status : 500;
  }
}

// HTTP and network failures reach Furin's error boundary; loaders only receive success data.
export function readData<Value>(result: ApiResult<Value>): Value {
  if (result.error !== null) {
    throw new ApiRequestError(result.error);
  }
  return result.data;
}
