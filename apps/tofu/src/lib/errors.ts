export function errorMessage(cause: unknown, fallback: string) {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number" &&
    "value" in cause
  ) {
    const value: unknown = cause.value;
    if (typeof value === "object" && value !== null) {
      if ("detail" in value && typeof value.detail === "string") {
        return value.detail;
      }
      if ("title" in value && typeof value.title === "string") {
        return value.title;
      }
    }
    return typeof value === "string" ? value : fallback;
  }
  return cause instanceof Error ? cause.message : fallback;
}
