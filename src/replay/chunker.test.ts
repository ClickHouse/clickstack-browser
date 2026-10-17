import { expect, test } from "vitest";
import { splitIntoChunks } from "./chunker.ts";

const encoder = new TextEncoder();
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("returns input that fits as one chunk", () => {
  expect(splitIntoChunks('{"type":4}')).toEqual(['{"type":4}']);
});

test("fills each chunk up to the byte limit", () => {
  expect(splitIntoChunks("a".repeat(10), 4)).toEqual(["aaaa", "aaaa", "aa"]);
});

test("cuts only between code points of 1 to 4 bytes, at every position around the limit", () => {
  for (const char of [
    "a",
    String.fromCodePoint(0xe9),
    String.fromCodePoint(0x20ac),
    String.fromCodePoint(0x1f600),
  ]) {
    for (let maxBytes = 4; maxBytes <= 9; maxBytes++) {
      for (let pad = 0; pad < 4; pad++) {
        const json = `${"x".repeat(pad)}${char.repeat(5)}y`;
        const chunks = splitIntoChunks(json, maxBytes);

        expect(chunks.join("")).toBe(json);

        for (const chunk of chunks) {
          expect(encoder.encode(chunk).byteLength).toBeLessThanOrEqual(
            maxBytes,
          );
          expect(chunk).not.toMatch(LONE_SURROGATE);
        }
      }
    }
  }
});
