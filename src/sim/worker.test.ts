import { expect, test } from "vitest";
import { catalogUrl } from "./worker";

test("catalogUrl joins a Pages sub-path base with the filename", () => {
  expect(catalogUrl("/goldengrove/", "https://hornvale.github.io")).toBe(
    "https://hornvale.github.io/goldengrove/hornvale_world.wasm",
  );
});

test("catalogUrl joins the root base for local dev/preview", () => {
  expect(catalogUrl("/", "http://localhost:4173")).toBe("http://localhost:4173/hornvale_world.wasm");
});

test("catalogUrl tolerates a base missing its trailing slash", () => {
  expect(catalogUrl("/goldengrove", "https://hornvale.github.io")).toBe(
    "https://hornvale.github.io/goldengrove/hornvale_world.wasm",
  );
});

test("catalogUrl builds the deployed /orrery/ sub-path url", () => {
  expect(catalogUrl("/orrery/", "https://hornvale.github.io")).toBe(
    "https://hornvale.github.io/orrery/hornvale_world.wasm",
  );
});

test("catalogUrl rejects a relative base, which silently drops the sub-path", () => {
  // A relative BASE_URL (`./`, ``) resolved against a bare origin produces a
  // rootless url that 404s under any Pages sub-path (orrery#7). catalogUrl
  // is defined only for absolute bases, so it fails loudly rather than
  // shipping a broken url.
  expect(() => catalogUrl("./", "https://hornvale.github.io")).toThrow(/absolute/);
  expect(() => catalogUrl("", "https://hornvale.github.io")).toThrow(/absolute/);
});
