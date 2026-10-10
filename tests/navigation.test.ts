import { expect, test } from "bun:test";
import { destinationFromPath } from "../src/lib/navigation";

test("malformed destination escapes have no destination", () => {
  expect(destinationFromPath("/thread/%")).toBeNull();
  expect(destinationFromPath("/thread/%E0%A4")).toBeNull();
  expect(destinationFromPath("/thread/Example%20show")).toBe("Example show");
});
