import { expect, test, vi } from "vitest";
import { CATALOG_VERSION, CatalogFetchError, loadCatalog, readOut, writeIn, statusError } from "./catalog";

function fakeExports(outText: string) {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const bytes = new TextEncoder().encode(outText);
  new Uint8Array(mem.buffer, 64, bytes.length).set(bytes);
  return {
    memory: mem,
    hw_in_ptr: () => 0,
    hw_out_ptr: () => 64,
    hw_out_len: () => bytes.length,
  };
}

test("readOut decodes the out buffer", () => {
  expect(readOut(fakeExports("hello") as never)).toBe("hello");
});

test("writeIn round-trips UTF-8 through the in buffer", () => {
  const e = fakeExports("");
  const n = writeIn(e as never, '{"plates":"12"}');
  expect(new TextDecoder().decode(new Uint8Array(e.memory.buffer, 0, n))).toBe('{"plates":"12"}');
});

test("statusError surfaces the envelope", () => {
  const err = statusError(1, '{"error":"the genesis of seed 7 refused: …"}');
  expect(err.code).toBe(1);
  expect(err.message).toContain("refused");
});

test("loadCatalog names the pinned catalog version when the fetch fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  try {
    await expect(loadCatalog("https://example.invalid/hornvale_world.wasm")).rejects.toThrow(CatalogFetchError);
    await expect(loadCatalog("https://example.invalid/hornvale_world.wasm")).rejects.toThrow(CATALOG_VERSION);
  } finally {
    vi.unstubAllGlobals();
  }
});
