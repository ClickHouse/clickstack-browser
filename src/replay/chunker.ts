import { MAX_CHUNK_BYTES } from './constants.ts';

// UTF-8 size of the code point at `index`. 4 means a pair (two UTF-16 code units)
function codePointBytes(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code < 0x80) {
    return 1;
  }

  if (code < 0x800) {
    return 2;
  }

  const next = value.charCodeAt(index + 1);

  return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
}

/**
 * Splits a serialized rrweb event into consecutive substrings of at most `maxBytes` UTF-8 bytes.
 *
 * @remarks
 * Cuts fall only between code points. Each chunk is UTF-8 encoded on its own, and half of a
 * surrogate pair would become U+FFFD. When joined in order the chunks give back `json` exactly.
 *
 * @param json The serialized event.
 * @param maxBytes The largest chunk in UTF-8 bytes. Defaults to 950 KiB.
 * @returns The chunks in order; `[json]` when it fits.
 * @internal
 */
export function splitIntoChunks(json: string, maxBytes: number = MAX_CHUNK_BYTES): string[] {
  // A UTF-16 code unit takes at most 3 UTF-8 bytes.
  if (json.length * 3 <= maxBytes) {
    return [json];
  }

  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < json.length;) {
    const size = codePointBytes(json, i);

    if (bytes + size > maxBytes && i > start) {
      chunks.push(json.slice(start, i));

      start = i;
      bytes = 0;
    }

    bytes += size;
    i += size === 4 ? 2 : 1;
  }

  chunks.push(json.slice(start));
  return chunks;
}
